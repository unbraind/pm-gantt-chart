/** JSON transport categories retain small control bounds while accepting complete saved snapshots. */
export type ScheduleFileKind = "controls" | "estimates" | "snapshot";
/** Read at most the declared budget plus one byte, including when a file grows after opening. */
export declare function readScheduleFile(raw: unknown, kind?: ScheduleFileKind): {
    ok: true;
    value: unknown;
    code?: undefined;
    message?: undefined;
    remedy?: undefined;
} | {
    value?: undefined;
    ok: false;
    code: "invalid_estimate";
    message: string;
    remedy: string;
};
//# sourceMappingURL=schedule-files.d.ts.map