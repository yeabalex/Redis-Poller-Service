import {
    WebSocketGateway,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { Server } from 'ws';
import { TopTracksService } from './top-tracks.service.js';
import { PaginatedResult, TrackEntry } from './track.interface.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** State stored per connected client. */
interface ClientPrefs {
    page: number;
    limit: number;
    /** Country the client registered — used to push the #1 country track. */
    country?: string;
}

/**
 * Client → Server messages:
 *
 *   { "type": "set_page",    "page": 2, "limit": 5 }
 *   { "type": "set_country", "country": "Ethiopia" }   ← subscribe to #1 country track
 *   { "type": "set_country", "country": null }          ← stop country pushes
 */
type IncomingMessage =
    | { type: 'set_page'; page?: number; limit?: number }
    | { type: 'set_country'; country: string | null };

@WebSocketGateway({ path: '/ws' })
export class TopTracksGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger(TopTracksGateway.name);
    private server: Server;

    private readonly clientPrefs = new Map<WebSocket, ClientPrefs>();

    constructor(private readonly topTracksService: TopTracksService) { }

    afterInit(server: Server) {
        this.server = server;
        this.logger.log('WebSocket gateway initialised at ws://<host>:<port>/ws');

        this.topTracksService.subscribe((tracks: TrackEntry[]) => {
            void this.broadcastAll(tracks);
        });
    }

    handleConnection(client: WebSocket) {
        this.logger.log('Client connected');

        const prefs: ClientPrefs = { page: DEFAULT_PAGE, limit: DEFAULT_LIMIT };
        this.clientPrefs.set(client, prefs);

        // Immediately push current global page.
        this.sendPaginated(client, this.topTracksService.getLastKnown(), prefs);

        client.on('message', (raw) => {
            void this.handleClientMessage(client, raw.toString());
        });
    }

    handleDisconnect(client: WebSocket) {
        this.clientPrefs.delete(client);
        this.logger.log('Client disconnected');
    }

    // ── Incoming message handler ───────────────────────────────────────────────

    private async handleClientMessage(client: WebSocket, raw: string): Promise<void> {
        let msg: IncomingMessage;
        try {
            msg = JSON.parse(raw) as IncomingMessage;
        } catch {
            this.sendError(client, 'Invalid JSON');
            return;
        }

        const prefs = this.clientPrefs.get(client) ?? {
            page: DEFAULT_PAGE,
            limit: DEFAULT_LIMIT,
        };

        // ── set_page ──────────────────────────────────────────────────────────
        if (msg.type === 'set_page') {
            if (msg.page !== undefined) {
                const p = Number(msg.page);
                if (!Number.isInteger(p) || p < 1) {
                    this.sendError(client, 'page must be a positive integer');
                    return;
                }
                prefs.page = p;
            }
            if (msg.limit !== undefined) {
                const l = Number(msg.limit);
                if (!Number.isInteger(l) || l < 1 || l > MAX_LIMIT) {
                    this.sendError(client, `limit must be an integer between 1 and ${MAX_LIMIT}`);
                    return;
                }
                prefs.limit = l;
            }
            this.clientPrefs.set(client, prefs);
            this.sendPaginated(client, this.topTracksService.getLastKnown(), prefs);
            return;
        }

        // ── set_country ───────────────────────────────────────────────────────
        if (msg.type === 'set_country') {
            const country = msg.country?.trim() || undefined;
            prefs.country = country;
            this.clientPrefs.set(client, prefs);

            if (country) {
                await this.sendCountryNo1(client, country);
            }
            return;
        }

        this.sendError(client, `Unknown message type: "${(msg as { type: string }).type}"`);
    }

    // ── Broadcast (after every poll) ──────────────────────────────────────────

    private async broadcastAll(all: TrackEntry[]): Promise<void> {
        if (!this.server) return;

        // Deduplicate countries so Redis is queried once per country,
        // not once per client.
        const uniqueCountries = new Map<string, TrackEntry | null>();

        for (const [, prefs] of this.clientPrefs) {
            if (prefs.country && !uniqueCountries.has(prefs.country)) {
                uniqueCountries.set(prefs.country, null); // placeholder
            }
        }

        await Promise.all(
            [...uniqueCountries.keys()].map(async (country) => {
                try {
                    uniqueCountries.set(country, await this.topTracksService.getCountryNo1(country));
                } catch (err) {
                    this.logger.error(`getCountryNo1 failed for "${country}"`, err);
                }
            }),
        );

        for (const [client, prefs] of this.clientPrefs) {
            if (client.readyState !== WebSocket.OPEN) continue;

            // Always push the global leaderboard.
            this.sendPaginated(client, all, prefs);

            // Additionally push the #1 country track if subscribed.
            if (prefs.country) {
                const track = uniqueCountries.get(prefs.country) ?? null;
                this.sendCountryNo1Result(client, prefs.country, track);
            }
        }
    }

    // ── Senders ───────────────────────────────────────────────────────────────

    private async sendCountryNo1(client: WebSocket, country: string): Promise<void> {
        try {
            const track = await this.topTracksService.getCountryNo1(country);
            this.sendCountryNo1Result(client, country, track);
        } catch (err) {
            this.logger.error(`sendCountryNo1 failed for "${country}"`, err);
            this.sendError(client, `Failed to fetch #1 track for country: ${country}`);
        }
    }

    private sendCountryNo1Result(
        client: WebSocket,
        country: string,
        track: TrackEntry | null,
    ): void {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
            client.send(JSON.stringify({ type: 'country_no1', country, track }));
        } catch (err) {
            this.logger.error('Failed to send country_no1 to client', err);
        }
    }

    private sendPaginated(
        client: WebSocket,
        all: TrackEntry[],
        prefs: ClientPrefs,
    ): void {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
            const paginated = this.paginate(all, prefs);
            client.send(JSON.stringify({ type: 'top_tracks', ...paginated }));
        } catch (err) {
            this.logger.error('Failed to send to client', err);
        }
    }

    private paginate(all: TrackEntry[], prefs: ClientPrefs): PaginatedResult<TrackEntry> {
        const safeLimit = Math.min(Math.max(prefs.limit, 1), MAX_LIMIT);
        const total = all.length;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
        const safePage = Math.min(Math.max(prefs.page, 1), totalPages);
        const offset = (safePage - 1) * safeLimit;
        const data = all
            .slice(offset, offset + safeLimit)
            .map((t, i) => ({ ...t, rank: offset + i + 1 }));
        return { page: safePage, limit: safeLimit, total, totalPages, data };
    }

    private sendError(client: WebSocket, message: string): void {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
            client.send(JSON.stringify({ type: 'error', message }));
        } catch {
            // best-effort
        }
    }
}
