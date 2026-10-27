import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEDULE_FILE_MAX_BYTES } from "./duration-input.js";
/** Read at most the declared budget plus one byte, including when a file grows after opening. */
export function readScheduleFile(raw, kind = "controls") {
    const limit = kind === "snapshot" ? SCHEDULE_FILE_MAX_BYTES : kind === "estimates" ? 65536 : 262144;
    try {
        if (typeof raw !== "string" || raw.length === 0)
            throw new Error("File required");
        const fd = openSync(resolve(raw), constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > limit)
                throw new Error("Bounded regular file required");
            const buffer = Buffer.alloc(Math.min(limit + 1, 65536)), chunks = [];
            let used = 0;
            while (used <= limit) {
                const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - used + 1), null);
                if (count === 0)
                    break;
                chunks.push(Buffer.from(buffer.subarray(0, count)));
                used += count;
            }
            if (used > limit)
                throw new Error("File exceeded its byte budget during reading");
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, used));
            return { ok: true, value: JSON.parse(text) };
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return { ok: false, code: "invalid_estimate", message: "Cannot read bounded schedule input.",
            remedy: `Provide readable regular JSON files no larger than ${limit} bytes for ${kind}; do not truncate saved snapshots.` };
    }
}
//# sourceMappingURL=schedule-files.js.map