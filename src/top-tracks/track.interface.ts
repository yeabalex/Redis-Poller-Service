export interface TrackEntry {
    rank: number;
    trackId: string;
    name: string;
    artist: string;
    album: string;
    image: string;
    url: string;
    listenerCount: number;
}

/** A single user currently listening to a specific track. */
export interface ListenerEntry {
    username: string;
    country: string;
}

/** Generic paginated envelope used by both the REST and WS responses. */
export interface PaginatedResult<T> {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    data: T[];
}

/** Country-scoped response wraps a paginated list plus the grand total. */
export interface CountryTopTracksResult {
    country: string;
    /** Total unique listeners from that country across ALL active tracks. */
    totalListeners: number;
    pagination: Omit<PaginatedResult<TrackEntry>, 'data'>;
    tracks: TrackEntry[];
}

export interface HistoryTrackEntry {
    name: string;
    artist: string;
    album: string;
    image: string;
    url: string;
    playedAt?: string | number; // Optional depending on how it's stored
    [key: string]: any;
}
