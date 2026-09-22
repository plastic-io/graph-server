/**
 * Work that outlives one call (plan §5.0, PB-084).
 *
 * A task is a promise that something is being done and an answer will be here
 * later.  These are about the promise being kept: that it always stops saying
 * "working", that it belongs to whoever asked for it, and that asking it to
 * stop reaches the work.
 */
const { TaskService, TASK_TTL_MS, taskView, taskAnswer } = require("../mcp/tasks");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:test"] };
const stranger = { sub: "auth0|u2", kind: "human", tenant: "personal:auth0|u2", scopes: [] };

const make = (iso = "2026-09-22T04:00:00.000Z", dispatch) => {
    const s3 = new FakeS3Service();
    let now = new Date(iso);
    const dispatched = [];
    const tasks = new TaskService(s3, {
        now: () => now,
        dispatch: dispatch === undefined ? async (task) => { dispatched.push(task.taskId); } : dispatch,
    });
    return { s3, tasks, dispatched, travel: (ms) => { now = new Date(now.getTime() + ms); } };
};

describe("starting a piece of work", () => {
    test("answers with something to poll, and hands it to the worker", async () => {
        const { tasks, dispatched } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1", input: { testId: "t1" } });
        expect(task).toMatchObject({ kind: "tests.run", graphId: "g1", status: "working", pollIntervalMs: 2000, ttlMs: TASK_TTL_MS });
        expect(task.taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(dispatched).toEqual([task.taskId]);
        expect(taskAnswer(task)).toMatchObject({ resultType: "task", task: { taskId: task.taskId, status: "working", pollIntervalMs: 2000 } });
    });

    test("says so at once when nothing will pick it up", async () => {
        const { tasks } = make("2026-09-22T04:00:00.000Z", async () => { throw new Error("no worker"); });
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        expect(task.status).toBe("failed");
        expect(task.error.message).toContain("no worker");
    });

    test("needs somebody to belong to", async () => {
        const { tasks } = make();
        expect(await tasks.create("tests.run", undefined, {})).toMatchObject({ code: "ADMISSION_DENIED" });
    });

    test("carries the principal it was created for, and never answers with it", async () => {
        const { tasks } = make();
        const task = await tasks.create("graph.invoke", agent, { graphId: "g1", input: { nodeUrl: "entry" } });
        expect(task.principal).toEqual({ sub: agent.sub, kind: "agent", tenant: agent.tenant, scopes: ["graph:test"] });
        const view = taskView(task);
        expect(view.principal).toBeUndefined();
        expect(view.by).toBe(agent.sub);
    });
});

describe("who a task belongs to", () => {
    test("the one who asked, and a person in the same tenant", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        expect((await tasks.get(task.taskId, agent)).taskId).toBe(task.taskId);
        expect((await tasks.get(task.taskId, owner)).taskId).toBe(task.taskId);
        expect(await tasks.get(task.taskId, stranger)).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await tasks.get(task.taskId, undefined)).toMatchObject({ code: "ADMISSION_DENIED" });
    });

    test("listing shows only what the caller may see", async () => {
        const { tasks } = make();
        await tasks.create("tests.run", agent, { graphId: "g1" });
        await tasks.create("graph.invoke", stranger, { graphId: "g2" });
        expect((await tasks.list(agent)).tasks.map((t) => t.kind)).toEqual(["tests.run"]);
        expect((await tasks.list(stranger)).tasks.map((t) => t.kind)).toEqual(["graph.invoke"]);
        expect((await tasks.list(owner, { graphId: "g1" })).tasks).toHaveLength(1);
        expect((await tasks.list(owner, { graphId: "g9" })).tasks).toHaveLength(0);
    });

    test("a task that is not there, and an id that is not one", async () => {
        const { tasks } = make();
        expect(await tasks.get("01M34AAAAAAAAAAAAAAAAAAAAA", agent)).toMatchObject({ code: "NOT_FOUND" });
        expect(await tasks.get("nope", agent)).toMatchObject({ code: "SCHEMA_INVALID" });
    });
});

describe("the work itself", () => {
    test("a result ends it as completed", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1", input: { testId: "t1" } });
        const done = await tasks.work(task.taskId, async (record) => ({ runs: [{ testId: record.input.testId, state: "passed" }], failed: 0 }));
        expect(done.status).toBe("completed");
        expect(done.result.runs[0]).toEqual({ testId: "t1", state: "passed" });
        expect(done.endedAt).toBeTruthy();
    });

    test("a refusal ends it as failed, with the reason the tool would have given", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        const done = await tasks.work(task.taskId, async () => ({ error: "no such test", code: "NOT_FOUND" }));
        expect(done.status).toBe("failed");
        expect(done.error).toEqual({ code: "NOT_FOUND", message: "no such test" });
    });

    test("a thrown error ends it too: a task that never resolves is worse than one that failed", async () => {
        const { tasks } = make();
        const task = await tasks.create("graph.invoke", agent, { graphId: "g1" });
        const done = await tasks.work(task.taskId, async () => { throw new Error("the runner fell over"); });
        expect(done.status).toBe("failed");
        expect(done.error).toMatchObject({ code: "INTERNAL", message: "the runner fell over" });
    });

    test("the work says what it is doing, so a poll is worth making", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        await tasks.progress(task.taskId, "3 of 8 tests", { executionId: "01M34BBBBBBBBBBBBBBBBBBBBB" });
        const seen = await tasks.get(task.taskId, agent);
        expect(seen.statusMessage).toBe("3 of 8 tests");
        expect(seen.executionId).toBe("01M34BBBBBBBBBBBBBBBBBBBBB");
        expect(seen.status).toBe("working");
    });

    test("work is done once: a second worker finds it finished and leaves it alone", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        await tasks.work(task.taskId, async () => ({ runs: [], failed: 0 }));
        const again = await tasks.work(task.taskId, async () => { throw new Error("this must not run"); });
        expect(again.status).toBe("completed");
    });
});

describe("asking the work to stop", () => {
    test("the work notices between steps and the task ends cancelled", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        const cancelled = await tasks.cancel(task.taskId, agent, "changed my mind");
        expect(cancelled.cancelRequested).toMatchObject({ by: agent.sub, reason: "changed my mind" });
        const steps = [];
        const done = await tasks.work(task.taskId, async (record, isCancelled) => {
            for (const step of ["one", "two", "three"]) {
                if (await isCancelled()) {
                    return { stoppedAfter: steps.slice() };
                }
                steps.push(step);
            }
            return { steps };
        });
        expect(steps).toEqual([]);
        expect(done.status).toBe("cancelled");
    });

    test("cancelling something already finished says so rather than pretending", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        await tasks.work(task.taskId, async () => ({ runs: [] }));
        const answer = await tasks.cancel(task.taskId, agent);
        expect(answer.alreadyFinished).toBe(true);
        expect(answer.status).toBe("completed");
    });

    test("only somebody the task belongs to may stop it", async () => {
        const { tasks } = make();
        const task = await tasks.create("tests.run", agent, { graphId: "g1" });
        expect(await tasks.cancel(task.taskId, stranger)).toMatchObject({ code: "ADMISSION_DENIED" });
    });
});

describe("forgetting", () => {
    test("a record older than its day is swept; a younger one is not", async () => {
        const ctx = make();
        const old = await ctx.tasks.create("tests.run", agent, { graphId: "g1" });
        ctx.travel(TASK_TTL_MS + 1000);
        const fresh = await ctx.tasks.create("tests.run", agent, { graphId: "g1" });
        const swept = await ctx.tasks.sweep();
        expect(swept.forgotten).toBe(1);
        expect(await ctx.tasks.get(old.taskId, agent)).toMatchObject({ code: "NOT_FOUND" });
        expect((await ctx.tasks.get(fresh.taskId, agent)).taskId).toBe(fresh.taskId);
    });
});
