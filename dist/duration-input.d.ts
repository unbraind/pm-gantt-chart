import type { PmItem, DeadlineRepairOptions, PrerequisiteGraph } from "./index.ts";
import type { CompletionIntervalOptions, ResolvedEstimate } from "./uncertainty.ts";
import type { ResourceScenarioOptions } from "./resources.ts";
import type { DurationCalibrationOptions } from "./calibration.ts";
/** One refusal contract shared by every untrusted duration-input boundary. */
export interface DurationInputRefusal {
    ok: false;
    code: "invalid_estimate";
    message: string;
    remedy: string;
}
/** Validation returns detached data; numerical code never sees the untrusted object. */
export type DurationInputResult<T> = {
    ok: true;
    value: T;
} | DurationInputRefusal;
/** Detached graph entries keep mutable Map objects outside validation receipts. */
type ValidatedGraph = readonly (readonly [string, readonly string[]])[];
/** Internal schema outputs; callers obtain them only from successful validation receipts. */
export interface ValidatedInputs {
    sampling: {
        graph?: ValidatedGraph;
        corpus: PmItem[];
        options: Omit<CompletionIntervalOptions, "estimates"> & {
            estimates?: Record<string, Exclude<ResolvedEstimate, null>>;
        };
    };
    calibration: DurationCalibrationOptions;
    resources: {
        graph?: ValidatedGraph;
        corpus: PmItem[];
        options: ResourceScenarioOptions;
    };
    repair: {
        graph?: ValidatedGraph;
        corpus: PmItem[];
        options: DeadlineRepairOptions;
    };
    corpus: PmItem[];
    graph: ValidatedGraph | undefined;
    storedEstimate: number | undefined;
    historyPoint: {
        type?: string;
        tags?: string[];
        at: string;
        minutes?: number;
        completed_at?: string;
        closed_at?: string;
    };
    elapsed: number;
}
/** Marker keeps foreign malformed input separate from unavailable tracker evidence. */
export declare class DurationInputError extends Error {
    readonly refusal: DurationInputRefusal;
    constructor(path: string);
}
/** Internal calculators accept only receipts minted by this module; forged values refuse. */
export declare function durationValidatedValue<K extends keyof ValidatedInputs>(kind: K, token: unknown): DurationInputResult<ValidatedInputs[K]>;
/** Boundary for SDK values, decoded CLI files/flags and SDK-read native fields; never throws. */
export declare function validateDurationInput<K extends keyof ValidatedInputs>(kind: K, input: unknown): DurationInputResult<ValidatedInputs[K]>;
/** Historical replay calls use the same schema, forwarding typed failures through the reader. */
export declare function requireDurationInput<K extends keyof ValidatedInputs>(kind: K, input: unknown): ValidatedInputs[K];
/** Decode numeric flag transport without coercing objects, symbols or other structured inputs. */
export declare function durationFlagNumber(value: unknown): unknown;
/** Decode the CLI CSV transport; array shape and probability bounds belong to the schema. */
export declare function durationFlagQuantiles(value: unknown): unknown;
/** Decode a supplied graph once, or clone already validated detached graph entries. */
export declare function durationInputGraph(stored: ValidatedGraph | undefined, override: PrerequisiteGraph | undefined): DurationInputResult<PrerequisiteGraph | undefined>;
export {};
//# sourceMappingURL=duration-input.d.ts.map