import {
    Controller,
    Get,
    Param,
    Query,
    BadRequestException,
    ParseIntPipe,
    DefaultValuePipe,
} from '@nestjs/common';
import { TopTracksService } from './top-tracks.service.js';
import { CountryTopTracksResult, ListenerEntry, PaginatedResult, TrackEntry, HistoryTrackEntry } from './track.interface.js';

@Controller()
export class TopTracksController {
    constructor(private readonly topTracksService: TopTracksService) { }

    /**
     * GET /top-tracks
     *   → paginated global leaderboard (cached, instant).
     *
     * GET /top-tracks?country=Ethiopia
     *   → paginated top tracks for that country + total listeners (live Redis query).
     *
     * Query params (both paths):
     *   page  – 1-indexed page number (default: 1)
     *   limit – items per page       (default: 10, max: 100)
     *
     * Global response shape:
     * { "page": 1, "limit": 10, "total": 42, "totalPages": 5, "data": [...] }
     *
     * Country response shape:
     * { "country": "Ethiopia", "totalListeners": 17,
     *   "pagination": { "page": 1, "limit": 10, "total": 5, "totalPages": 1 },
     *   "tracks": [...] }
     */
    @Get('top-tracks')
    async getTopTracks(
        @Query('country') country?: string,
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
        @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number = 10,
    ): Promise<PaginatedResult<TrackEntry> | CountryTopTracksResult> {
        if (country !== undefined) {
            const trimmed = country.trim();
            if (!trimmed) {
                throw new BadRequestException('country query param must not be empty');
            }
            return this.topTracksService.getTopByCountry(trimmed, page, limit);
        }

        // No country filter — paginate from the in-memory cache instantly.
        return this.topTracksService.getPage(page, limit);
    }

    /**
     * GET /top-tracks/:trackId/listeners
     *   → paginated list of users currently listening to the specified track.
     *
     * Query params:
     *   page  – 1-indexed page number (default: 1)
     *   limit – items per page       (default: 10, max: 100)
     *
     * Response shape:
     * { "page": 1, "limit": 10, "total": 34, "totalPages": 4,
     *   "data": [ { "username": "alice", "country": "ethiopia" }, ... ] }
     */
    @Get('top-tracks/:trackId/listeners')
    async getListeners(
        @Param('trackId') trackId: string,
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
        @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number = 10,
    ): Promise<PaginatedResult<ListenerEntry>> {
        if (!trackId?.trim()) {
            throw new BadRequestException('trackId must not be empty');
        }
        return this.topTracksService.getListenersByTrack(trackId.trim(), page, limit);
    }

    /**
     * GET /user-history
     *   → paginated list of a user's recently listened tracks.
     *
     * Query params:
     *   userKey - explicitly provided user key (optional)
     *   username - used with country to derive userKey (optional)
     *   country - used with username to derive userKey (optional)
     *   page  – 1-indexed page number (default: 1)
     *   limit – items per page       (default: 10, max: 100)
     */
    @Get('user-history')
    async getUserHistory(
        @Query('userKey') queryUserKey?: string,
        @Query('username') username?: string,
        @Query('country') country?: string,
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
        @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number = 10,
    ): Promise<PaginatedResult<HistoryTrackEntry>> {
        let userKey = queryUserKey?.trim();

        if (!userKey) {
            if (username?.trim() && country?.trim()) {
                userKey = `${username.trim()}_${country.trim()}`;
            } else {
                throw new BadRequestException('Must provide either userKey or both username and country');
            }
        }

        return this.topTracksService.getUserHistory(userKey, page, limit);
    }
}
