import { ulid } from "ulid";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";

/**
 * Work that outlives one call (plan §5.0, PB-084).
 *
 * A protocol call has about twenty seconds before the gateway gives up, and
 * some of what an agent asks for honestly takes longer: every test of a graph,
 * a run that waits on a browser, a simulation over recorded executions.  The
 * answer to those is a task — a durable record of work that has started, which
 * the caller polls.
 *
 * A task carries the principal it was created for, because the work happens in
 * another invocation with nobody to ask.  That is the whole reason to be strict
 * about it: the record names who asked, the worker acts as exactly that
 * principal and no more, and only that principal (or a person in the same
 * tenant) may read or cancel it.
 */

export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

/** A day: long enough to come back to tomorrow, short enough to forget. */
export const TASK_TTL_MS = 86400000;
/** How often the answer says to ask again. */
export const POLL_INTERVAL_MS = 2000;

export interface TaskRecord {
    taskId: string;
    kind: string;
    graphId?: string;
    status: TaskStatus;
    createdAt: string;
    updatedAt: string;
    ttlMs: number;
    pollIntervalMs: number;
    /** Who asked, and what the work is allowed to be. */
    principal: { sub: string; kind: string; tenant: string; scopes?: string[] };
    input: any;
    statusMessage?: string;
    result?: any;
    error?: { code: string; message: string };
    cancelRequested?: { at: string; by: string; reason?: string };
    /** What the work touched, so a cancel can reach it. */
    executionId?: string;
    startedAt?: string;
    endedAt?: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class TaskService {
    constructor(private store: Store, private deps: { now?: () => Date; dispatch?: (task: TaskRecord) => Promise<void> } = {}) {}

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    static key(taskId: string): string {
        return `tasks/${taskId}.json`;
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    /** Start a piece of work and answer with something to poll. */
    async create(kind: string, principal: Principal | undefined, options: { graphId?: string; input?: any; ttlMs?: number }): Promise<TaskRecord | { error: string; code: string }> {
        if (!principal) {
            return { error: "a task needs somebody to belong to", code: "ADMISSION_DENIED" };
        }
        const at = this.now().toISOString();
        const task: TaskRecord = {
            taskId: ulid(),
            kind,
            graphId: options.graphId,
            status: "working",
            createdAt: at,
            updatedAt: at,
            ttlMs: options.ttlMs || TASK_TTL_MS,
            pollIntervalMs: POLL_INTERVAL_MS,
            principal: { sub: principal.sub, kind: principal.kind, tenant: principal.tenant, scopes: (principal as any).scopes },
            input: options.input === undefined ? null : options.input,
        };
        await this.putJson(TaskService.key(task.taskId), task);
        if (this.deps.dispatch) {
            try {
                await this.deps.dispatch(task);
            } catch (err: any) {
                // Nothing will pick it up, so say so now rather than leaving a
                // task that is "working" and never will be.
                const failed = { ...task, status: "failed" as TaskStatus, updatedAt: this.now().toISOString(), error: { code: "INTERNAL", message: `this work could not be started: ${err && err.message}` } };
                await this.putJson(TaskService.key(task.taskId), failed);
                return failed;
            }
        }
        return task;
    }

    /** May this principal see this task?  The one who asked, or a person in the same tenant. */
    private mayRead(task: TaskRecord, principal: Principal | undefined): boolean {
        if (!principal) {
            return false;
        }
        if (principal.sub === task.principal.sub) {
            return true;
        }
        return principal.kind === "human" && principal.tenant === task.principal.tenant;
    }

    async get(taskId: string, principal: Principal | undefined): Promise<any> {
        if (!ULID_RE.test(String(taskId))) {
            return { error: "a taskId is a ULID", code: "SCHEMA_INVALID" };
        }
        const task: TaskRecord = await this.getJson(TaskService.key(taskId));
        if (!task) {
            return { error: "no such task", code: "NOT_FOUND" };
        }
        if (!this.mayRead(task, principal)) {
            return { error: "that task belongs to somebody else", code: "ADMISSION_DENIED" };
        }
        return task;
    }

    async list(principal: Principal | undefined, options: { graphId?: string; limit?: number } = {}): Promise<any> {
        if (!principal) {
            return { error: "denied", code: "ADMISSION_DENIED" };
        }
        const limit = Math.min(100, Math.max(1, options.limit || 25));
        const keys = (await this.listKeys("tasks/")).filter((key) => key.endsWith(".json")).sort().reverse();
        const tasks: TaskRecord[] = [];
        for (const key of keys) {
            if (tasks.length >= limit) {
                break;
            }
            const task: TaskRecord = await this.getJson(key);
            if (!task || !this.mayRead(task, principal)) {
                continue;
            }
            if (options.graphId && task.graphId !== options.graphId) {
                continue;
            }
            tasks.push(task);
        }
        return { tasks };
    }

    /**
     * Ask the work to stop.  It is cooperative, like cancelling an execution:
     * the worker notices between steps, and what is already in flight is not
     * taken back.
     */
    async cancel(taskId: string, principal: Principal | undefined, reason?: string): Promise<any> {
        const task = await this.get(taskId, principal);
        if (task.error) {
            return task;
        }
        if (task.status !== "working") {
            return { ...task, alreadyFinished: true };
        }
        const next: TaskRecord = {
            ...task,
            cancelRequested: { at: this.now().toISOString(), by: principal!.sub, reason: reason ? String(reason).slice(0, 200) : undefined },
            updatedAt: this.now().toISOString(),
        };
        await this.putJson(TaskService.key(taskId), next);
        return next;
    }

    /** Has a cancel been asked for?  The worker calls this between steps. */
    async cancelRequested(taskId: string): Promise<boolean> {
        const task: TaskRecord = await this.getJson(TaskService.key(taskId));
        return !!(task && task.cancelRequested);
    }

    /** Say what the work is doing, so a poll is worth making. */
    async progress(taskId: string, statusMessage: string, extra: Partial<TaskRecord> = {}): Promise<void> {
        const task: TaskRecord = await this.getJson(TaskService.key(taskId));
        if (!task || task.status !== "working") {
            return;
        }
        await this.putJson(TaskService.key(taskId), { ...task, ...extra, statusMessage: String(statusMessage).slice(0, 200), updatedAt: this.now().toISOString() });
    }

    /**
     * Run the work of a task and record how it ended.  Whatever happens — a
     * result, a refusal, a thrown error, a cancel — the record stops saying
     * "working", because a task that never resolves is worse than one that
     * failed.
     */
    async work(taskId: string, run: (task: TaskRecord, cancelled: () => Promise<boolean>) => Promise<any>): Promise<TaskRecord | null> {
        const task: TaskRecord = await this.getJson(TaskService.key(taskId));
        if (!task) {
            return null;
        }
        if (task.status !== "working") {
            return task;                                 // already finished, or already cancelled
        }
        const startedAt = this.now().toISOString();
        await this.putJson(TaskService.key(taskId), { ...task, startedAt, updatedAt: startedAt });
        const finish = async (patch: Partial<TaskRecord>) => {
            const current: TaskRecord = (await this.getJson(TaskService.key(taskId))) || task;
            const endedAt = this.now().toISOString();
            const next = { ...current, ...patch, endedAt, updatedAt: endedAt } as TaskRecord;
            await this.putJson(TaskService.key(taskId), next);
            return next;
        };
        try {
            const result = await run(task, () => this.cancelRequested(taskId));
            if (await this.cancelRequested(taskId)) {
                return await finish({ status: "cancelled", result });
            }
            if (result && result.error && result.code) {
                return await finish({ status: "failed", error: { code: String(result.code), message: String(result.error) } });
            }
            return await finish({ status: "completed", result });
        } catch (err: any) {
            return await finish({ status: "failed", error: { code: "INTERNAL", message: String((err && err.message) || err).slice(0, 2000) } });
        }
    }

    /** Records past their day are forgotten; the tick calls this. */
    async sweep(): Promise<{ considered: number; forgotten: number }> {
        const now = this.now().getTime();
        const keys = (await this.listKeys("tasks/")).filter((key) => key.endsWith(".json"));
        let forgotten = 0;
        for (const key of keys) {
            const task: TaskRecord = await this.getJson(key);
            if (!task) {
                continue;
            }
            if (now - new Date(task.createdAt).getTime() > (task.ttlMs || TASK_TTL_MS)) {
                await new Promise<void>((resolve) => this.store.remove(key, () => resolve()));
                forgotten += 1;
            }
        }
        return { considered: keys.length, forgotten };
    }
}

/** What a tool answers with instead of a result it cannot produce in time. */
export function taskAnswer(task: TaskRecord) {
    return {
        resultType: "task",
        task: {
            taskId: task.taskId,
            kind: task.kind,
            status: task.status,
            pollIntervalMs: task.pollIntervalMs,
            ttlMs: task.ttlMs,
            createdAt: task.createdAt,
            graphId: task.graphId,
        },
    };
}

/** What a poll answers with: the record, without the principal it belongs to. */
export function taskView(task: TaskRecord) {
    const { principal, ...rest } = task;
    return { ...rest, by: principal.sub };
}
