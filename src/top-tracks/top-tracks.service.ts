import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service.js';
import { CountryTopTracksResult, ListenerEntry, PaginatedResult, TrackEntry, HistoryTrackEntry } from './track.interface.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

@Injectable()
export class TopTracksService implements OnModuleInit {
    private readonly logger = new Logger(TopTracksService.name);

    /** The most recently computed leaderboard. Survives Redis blips. */
    private lastKnownTop: TrackEntry[] = [];

    /** Subscribers that want to be notified after every poll. */
    private readonly listeners: Set<(tracks: TrackEntry[]) => void> = new Set();

    private pollTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
    ) { }

    onModuleInit() {
        const pollIntervalMs = this.configService.get<number>('POLL_INTERVAL_MS', 60_000);
        this.logger.log(`Poll interval set to ${pollIntervalMs} ms`);

        // Run the first poll immediately, then set the interval.
        void this.poll();
        this.pollTimer = setInterval(() => void this.poll(), pollIntervalMs);
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /** Raw full sorted list — for internal/WS use. */
    getLastKnown(): TrackEntry[] {
        return this.lastKnownTop;
    }

    /**
     * Returns a paginated slice of the cached global leaderboard.
     * page is 1-indexed. limit is clamped to [1, MAX_LIMIT].
     */
    getPage(page: number, limit: number): PaginatedResult<TrackEntry> {
        const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
        const all = this.lastKnownTop;
        const total = all.length;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const data = all
            .slice(offset, offset + safeLimit)
            .map((t, i) => ({ ...t, rank: offset + i + 1 }));
        return { page: safePage, limit: safeLimit, total, totalPages, data };
    }

    /**
     * Computes the top tracks **and** total listener count for a specific
     * country, live from Redis, and returns a paginated result.
     */
    async getTopByCountry(
        country: string,
        page = 1,
        limit = DEFAULT_LIMIT,
    ): Promise<CountryTopTracksResult> {
        try {
            return await this.computeTopTracksByCountry(country, page, limit);
        } catch (err) {
            this.logger.error(
                `Country query failed for "${country}" — returning empty result`,
                err instanceof Error ? err.message : String(err),
            );
            return {
                country,
                totalListeners: 0,
                pagination: { page: 1, limit, total: 0, totalPages: 1 },
                tracks: [],
            };
        }
    }

    /**
     * Returns a paginated list of users currently listening to a given track.
     * Reads live from Redis — no cache.
     * page is 1-indexed. limit is clamped to [1, MAX_LIMIT].
     */
    async getListenersByTrack(
        trackId: string,
        page = 1,
        limit = DEFAULT_LIMIT,
    ): Promise<PaginatedResult<ListenerEntry>> {
        const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
        const redis = this.redisService.getClient();

        const members: string[] = await redis.smembers(`track:${trackId}:listeners`);

        // Parse "username_country" — split on the LAST underscore so usernames
        // that contain underscores are handled correctly.
        const listeners: ListenerEntry[] = members
            .map((m) => {
                const idx = m.lastIndexOf('_');
                if (idx === -1) return { username: m, country: '' };
                return { username: m.slice(0, idx), country: m.slice(idx + 1) };
            })
            .sort((a, b) => a.username.localeCompare(b.username));

        const total = listeners.length;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const data = listeners.slice(offset, offset + safeLimit);

        return { page: safePage, limit: safeLimit, total, totalPages, data };
    }

    /**
     * Returns the single #1 track being listened to by users in the given
     * country right now, or null if nobody from that country is active.
     * Reads live from Redis — no cache.
     */
    async getCountryNo1(country: string): Promise<TrackEntry | null> {
        const result = await this.getTopByCountry(country, 1, 1);
        return result.tracks[0] ?? null;
    }

    /**
     * Retrieves the list of recently played tracks for a given user from Redis.
     * Reads from the list user:{userKey}:history.
     */
    async getUserHistory(
        userKey: string,
        page = 1,
        limit = DEFAULT_LIMIT,
    ): Promise<PaginatedResult<HistoryTrackEntry>> {
        const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
        const safePage = Math.max(page, 1);
        const redis = this.redisService.getClient();

        const key = `user:${userKey}:history`;

        try {
            // Use LLEN to get the total number of items
            const total = await redis.llen(key);
            const totalPages = Math.max(Math.ceil(total / safeLimit), 1);

            // Calculate LRANGE indices (0-indexed inclusive for Redis)
            const start = (safePage - 1) * safeLimit;
            const end = start + safeLimit - 1;

            let data: HistoryTrackEntry[] = [];
            if (total > 0 && start < total) {
                const resultList = await redis.lrange(key, start, end);
                data = resultList.map((item) => {
                    try {
                        return JSON.parse(item) as HistoryTrackEntry;
                    } catch (e) {
                        this.logger.warn(`Failed to parse history track entry for user ${userKey}: ${item}`);
                        return null;
                    }
                }).filter((item): item is HistoryTrackEntry => item !== null);
            }

            return {
                page: Math.min(safePage, totalPages || 1),
                limit: safeLimit,
                total,
                totalPages,
                data,
            };
        } catch (error) {
            this.logger.error(`Error fetching user history for ${userKey} from Redis`, error);
            throw new InternalServerErrorException('Failed to retrieve user history');
        }
    }

    /** Register a callback that fires after every successful (or cached) poll. */
    subscribe(cb: (tracks: TrackEntry[]) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    // ── Polling Logic ────────────────────────────────────────────────────────────

    private async poll(): Promise<void> {
        try {
            const top = await this.computeTopTracks();
            this.lastKnownTop = top;
            this.notify(top);
        } catch (err) {
            this.logger.error(
                'Poll failed — serving last known result',
                err instanceof Error ? err.message : String(err),
            );
            // Still notify with the last known result so WS clients get something.
            this.notify(this.lastKnownTop);
        }
    }

    private notify(tracks: TrackEntry[]): void {
        for (const cb of this.listeners) {
            try {
                cb(tracks);
            } catch {
                // Individual listener errors must not crash the poller.
            }
        }
    }

    // ── Redis Queries ────────────────────────────────────────────────────────────

    private async computeTopTracks(): Promise<TrackEntry[]> {
        const redis = this.redisService.getClient();

        // 1. SCAN for all track:*:listeners keys.
        const listenerKeys = await this.scanKeys(redis, 'track:*:listeners');
        this.logger.debug(`[Redis SCAN] Found ${listenerKeys.length} listener key(s): ${JSON.stringify(listenerKeys)}`);

        if (listenerKeys.length === 0) return [];

        // 2. Pipeline SCARD for every key.
        const pipeline = redis.pipeline();
        for (const key of listenerKeys) pipeline.scard(key);
        const scardResults = await pipeline.exec();
        this.logger.debug(`[Redis SCARD] Raw pipeline results: ${JSON.stringify(scardResults)}`);

        // 3. Build (trackId, count) pairs, filtering out 0-listener tracks.
        type Pair = { trackId: string; count: number };
        const pairs: Pair[] = [];

        for (let i = 0; i < listenerKeys.length; i++) {
            const [err, count] = scardResults![i] as [Error | null, number];
            if (err) {
                this.logger.warn(`[Redis SCARD] Error for key "${listenerKeys[i]}": ${err.message}`);
                continue;
            }
            if (count <= 0) continue;                      // offline / GC'd

            // key format: track:{trackId}:listeners
            const trackId = listenerKeys[i].split(':')[1];
            pairs.push({ trackId, count });
        }

        this.logger.debug(`[Redis] Pairs after SCARD filter: ${JSON.stringify(pairs)}`);

        // 4. Sort descending — keep ALL tracks; pagination happens at query time.
        pairs.sort((a, b) => b.count - a.count);

        if (pairs.length === 0) return [];

        const topPairs = pairs; // no hard cap — full sorted list

        // 5. Pipeline HGETALL for each trackId.
        const metaPipeline = redis.pipeline();
        for (const { trackId } of topPairs)
            metaPipeline.hgetall(`track:${trackId}:meta`);

        const metaResults = await metaPipeline.exec();
        this.logger.debug(`[Redis HGETALL] Raw meta results: ${JSON.stringify(metaResults)}`);

        // 6. Assemble the response array.
        const result: TrackEntry[] = [];
        for (let i = 0; i < topPairs.length; i++) {
            const [err, meta] = metaResults![i] as [Error | null, Record<string, string>];
            if (err) {
                this.logger.warn(`[Redis HGETALL] Error for trackId "${topPairs[i].trackId}": ${err.message}`);
                continue;
            }
            if (!meta) {
                this.logger.warn(`[Redis HGETALL] No meta found for trackId "${topPairs[i].trackId}"`);
                continue;
            }

            result.push({
                rank: i + 1,
                trackId: topPairs[i].trackId,
                name: meta.name ?? '',
                artist: meta.artist ?? '',
                album: meta.album ?? '',
                image: meta.image ?? '',
                url: meta.url ?? '',
                listenerCount: topPairs[i].count,
            });
        }

        this.logger.debug(`[Redis] Final computed top tracks: ${JSON.stringify(result)}`);
        return result;
    }

    // ── Country-filtered query ────────────────────────────────────────────────

    private async computeTopTracksByCountry(
        country: string,
        page = 1,
        limit = DEFAULT_LIMIT,
    ): Promise<CountryTopTracksResult> {
        const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
        const redis = this.redisService.getClient();
        const normalised = country.trim().toLowerCase();

        // 1. Find all listener-set keys.
        const listenerKeys = await this.scanKeys(redis, 'track:*:listeners');
        if (listenerKeys.length === 0) {
            return { country, totalListeners: 0, pagination: { page: 1, limit, total: 0, totalPages: 1 }, tracks: [] };
        }

        // 2. Pipeline SMEMBERS for every key so we can inspect each member's country.
        const pipeline = redis.pipeline();
        for (const key of listenerKeys) pipeline.smembers(key);
        const smembersResults = await pipeline.exec();

        // 3. Count members whose country suffix matches.
        //    Also accumulate the grand total across ALL tracks for that country.
        type Pair = { trackId: string; count: number };
        const pairs: Pair[] = [];
        let totalListeners = 0;

        for (let i = 0; i < listenerKeys.length; i++) {
            const [err, members] = smembersResults![i] as [Error | null, string[]];
            if (err || !members) continue;

            const matching = members.filter((m) => {
                // Format: "username_country" — split on last underscore.
                const idx = m.lastIndexOf('_');
                if (idx === -1) return false;
                return m.slice(idx + 1).toLowerCase() === normalised;
            });

            if (matching.length === 0) continue;

            totalListeners += matching.length;   // accumulate grand total

            const trackId = listenerKeys[i].split(':')[1];
            pairs.push({ trackId, count: matching.length });
        }

        // 4. Sort all, then paginate — only HGETALL the page we actually need.
        pairs.sort((a, b) => b.count - a.count);
        const total = pairs.length;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;

        const pagination = { page: safePage, limit: safeLimit, total, totalPages };

        if (total === 0) {
            return { country, totalListeners, pagination, tracks: [] };
        }

        const topPairs = pairs.slice(offset, offset + safeLimit);

        // 5. Fetch metadata only for the current page's tracks.
        const metaPipeline = redis.pipeline();
        for (const { trackId } of topPairs)
            metaPipeline.hgetall(`track:${trackId}:meta`);
        const metaResults = await metaPipeline.exec();

        // 6. Assemble.
        const tracks: TrackEntry[] = [];
        for (let i = 0; i < topPairs.length; i++) {
            const [err, meta] = metaResults![i] as [Error | null, Record<string, string>];
            if (err || !meta) continue;

            tracks.push({
                rank: offset + i + 1,
                trackId: topPairs[i].trackId,
                name: meta.name ?? '',
                artist: meta.artist ?? '',
                album: meta.album ?? '',
                image: meta.image ?? '',
                url: meta.url ?? '',
                listenerCount: topPairs[i].count,
            });
        }

        return { country, totalListeners, pagination, tracks };
    }

    /**
     * Full SCAN loop — returns every key matching the pattern.
     * Uses cursor-based iteration to avoid blocking the server.
     */
    private async scanKeys(redis: import('ioredis').Redis, pattern: string): Promise<string[]> {
        const keys: string[] = [];
        let cursor = '0';

        do {
            const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = nextCursor;
            keys.push(...batch);
        } while (cursor !== '0');

        return keys;
    }
}
