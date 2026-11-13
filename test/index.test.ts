import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { getFinalOutput, type SingleResult } from "../src/index.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/agents.ts", () => ({
	discoverAgents: () => ({
		agents: [{ name: "worker", description: "测试 Agent", source: "user", systemPrompt: "", filePath: "/mock/worker.md" }],
		projectAgentsDir: null,
	}),
	formatAgentList: () => ({ text: "worker (user): 测试 Agent", remaining: 0 }),
}));

type SavedTool = ToolDefinition<any, { mode: string; results: SingleResult[] }>;
type Result = Awaited<ReturnType<SavedTool["execute"]>>;

class FakeProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn((_signal: NodeJS.Signals) => {
		this.killed = true;
		return true;
	});
	close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
}

function message(text: string, stopReason = "stop", errorMessage?: string) {
	return {
		role: "assistant", content: [{ type: "text", text }], model: "mock-model", stopReason, errorMessage,
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } },
	};
}
function send(proc: FakeProcess, text: string, stopReason = "stop", errorMessage?: string, newline = true) {
	proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: message(text, stopReason, errorMessage) }) + (newline ? "\n" : "")));
}
async function drain() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

let tool: SavedTool;
let processes: FakeProcess[];
const ctx = {
	cwd: "/mock/cwd", hasUI: false, isProjectTrusted: () => false,
	model: { provider: "mock", id: "parent" }, thinkingLevel: "high",
} as unknown as ExtensionToolContext;
function execute(params: unknown = { agent: "worker", task: "任务" }, signal?: AbortSignal, onUpdate?: Parameters<SavedTool["execute"]>[3]) {
	return tool.execute("test", params, signal, onUpdate, ctx);
}
function text(result: Result) {
	return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}
function render(result: Result, expanded = false) {
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	return tool.renderResult!(result, { expanded, isPartial: false } as any, theme as any, {} as any).render(120).join("\n");
}

beforeEach(() => {
	processes = [];
	mocks.spawn.mockReset().mockImplementation(() => {
		const proc = new FakeProcess();
		processes.push(proc);
		return proc;
	});
	extension({ registerTool: (definition: SavedTool) => { tool = definition; } } as unknown as ExtensionAPI);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("进程生命周期", () => {
	it("正常完成、保留完整输出和 usage，继承原 cwd 与模型", async () => {
		const promise = execute();
		send(processes[0], "完成");
		processes[0].close();
		const result = await promise;
		expect(result.isError).not.toBe(true);
		expect(text(result)).toBe("完成");
		expect(result.details.results[0]).toMatchObject({ status: "completed", exitCode: 0, usage: { turns: 1, input: 2, output: 3 } });
		expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--model", "mock/parent", "--thinking", "high"]));
		expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: "/mock/cwd", shell: false });
	});

	it("非零退出同时保留 stderr、模型错误及部分输出", async () => {
		const promise = execute();
		send(processes[0], "已修改文件", "error", "模型报错");
		processes[0].stderr.emit("data", Buffer.from("进程报错"));
		processes[0].close(2);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.details.results[0]).toMatchObject({ status: "failed", exitCode: 2 });
		for (const evidence of ["已修改文件", "模型报错", "进程报错"]) {
			expect(text(result)).toContain(evidence);
			expect(render(result, true)).toContain(evidence);
		}
	});

	it.each(["SIGTERM", "SIGKILL"] as const)("信号 %s 退出不误判成功", async (signal) => {
		const promise = execute();
		processes[0].close(null, signal);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.details.results[0]).toMatchObject({ status: "failed", exitCode: null, terminationSignal: signal });
		expect(text(result)).toContain(signal);
	});

	it("spawn error 等待 close 并保留诊断", async () => {
		const promise = execute();
		let settled = false;
		void promise.then(() => { settled = true; });
		processes[0].emit("error", new Error("ENOENT mock-pi"));
		await drain();
		expect(settled).toBe(false);
		processes[0].stderr.emit("data", Buffer.from("启动失败"));
		processes[0].close(-2);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("ENOENT mock-pi");
		expect(text(result)).toContain("启动失败");
	});

	it("同步 spawn 抛错也返回完整失败 details", async () => {
		mocks.spawn.mockImplementationOnce(() => { throw new Error("spawn sync failure"); });
		const result = await execute();
		expect(result.isError).toBe(true);
		expect(result.details.results[0].status).toBe("failed");
		expect(text(result)).toContain("spawn sync failure");
	});

	it("预先取消不 spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await execute(undefined, controller.signal);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details.results[0]).toMatchObject({ status: "aborted", exitCode: null });
	});

	it("取消后等待 close，TERM 五秒后即使 killed 为 true 仍发送 KILL", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const promise = execute(undefined, controller.signal);
		let settled = false;
		void promise.then(() => { settled = true; });
		send(processes[0], "部分输出");
		controller.abort();
		expect(processes[0].killed).toBe(true);
		expect(processes[0].kill.mock.calls).toEqual([["SIGTERM"]]);
		await vi.advanceTimersByTimeAsync(4999);
		expect(processes[0].kill).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(processes[0].kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(settled).toBe(false);
		processes[0].close(null, "SIGKILL");
		const result = await promise;
		expect(result.details.results[0].status).toBe("aborted");
		expect(text(result)).toContain("部分输出");
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("TERM 后正常退出会清理 timer，不再 KILL", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = execute(undefined, controller.signal);
		controller.abort();
		processes[0].close();
		await promise;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(6000);
		expect(processes[0].kill.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("正常完成清理 abort listener，后续取消不 kill", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const promise = execute(undefined, controller.signal);
		processes[0].close();
		await promise;
		controller.abort();
		await vi.advanceTimersByTimeAsync(6000);
		expect(processes[0].kill).not.toHaveBeenCalled();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("exit 后 close 前不再发送信号，仍等待管道关闭", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = execute(undefined, controller.signal);
		processes[0].emit("exit", 0, null);
		controller.abort();
		await vi.advanceTimersByTimeAsync(6000);
		expect(processes[0].kill).not.toHaveBeenCalled();
		processes[0].emit("close", 0, null);
		expect((await promise).details.results[0].status).toBe("completed");
	});

	it("stdout/stderr 中文与 emoji 跨字节块且末行无换行仍正确解码", async () => {
		const promise = execute();
		const output = "中文😀输出";
		const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: message(output) }));
		for (const byte of bytes) processes[0].stdout.emit("data", Buffer.from([byte]));
		for (const byte of Buffer.from("中文😀诊断")) processes[0].stderr.emit("data", Buffer.from([byte]));
		processes[0].close();
		const result = await promise;
		expect(text(result)).toBe(output);
		expect(result.details.results[0].stderr).toBe("中文😀诊断");
	});

	it("开始进度回调触发取消时仍不 spawn", async () => {
		const controller = new AbortController();
		const result = await execute(undefined, controller.signal, () => controller.abort());
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(result.details.results[0].status).toBe("aborted");
	});

	it.each(["nonzero", "signal", "error"])("%s 收尾后清理 listener/timer", async (kind) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const promise = execute(undefined, controller.signal);
		if (kind === "error") processes[0].emit("error", new Error("ENOENT"));
		processes[0].close(kind === "signal" ? null : 1, kind === "signal" ? "SIGKILL" : null);
		await promise;
		controller.abort();
		await vi.advanceTimersByTimeAsync(6000);
		expect(processes[0].kill).not.toHaveBeenCalled();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("运行中状态不是成功，UI 显示等待图标", async () => {
		const updates: Result[] = [];
		const promise = execute(undefined, undefined, (result) => { updates.push(structuredClone(result)); });
		send(processes[0], "执行中");
		const update = updates.at(-1)!;
		expect(update.details.results[0]).toMatchObject({ status: "running", exitCode: null });
		expect(render(update)).toContain("⏳");
		expect(render(update)).not.toContain("✓");
		processes[0].close();
		await promise;
	});
});

describe("并行调度", () => {
	const tasks = (count: number) => ({ tasks: Array.from({ length: count }, (_, i) => ({ agent: "worker", task: `任务${i}` })) });

	it("进度区分 pending/running/完成，结果按输入顺序保留", async () => {
		const updates: Result[] = [];
		const promise = execute(tasks(5), undefined, (result) => { updates.push(structuredClone(result)); });
		expect(processes).toHaveLength(4);
		expect(text(updates.at(-1)!)).toContain("0/5 done, 4 running, 1 pending");
		expect(render(updates.at(-1)!)).toContain("0/5 done");
		send(processes[2], "第三项");
		processes[2].close();
		await drain();
		expect(processes).toHaveLength(5);
		for (const index of [4, 1, 3, 0]) {
			send(processes[index], `输出${index}`);
			processes[index].close();
		}
		const result = await promise;
		expect(result.details.results.map((r) => r.task)).toEqual(["任务0", "任务1", "任务2", "任务3", "任务4"]);
		expect(result.details.results.every((r) => r.status === "completed")).toBe(true);
		expect(text(result)).toContain("5/5 succeeded");
	});

	it.each([1, 2])("%i 项失败时设置 isError，不声称没有副作用", async (failures) => {
		const promise = execute(tasks(2));
		for (let i = 0; i < 2; i++) {
			send(processes[i], "可能已写入文件");
			processes[i].close(i < failures ? 1 : 0);
		}
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(`${2 - failures}/2 succeeded`);
		expect(text(result)).not.toMatch(/nothing has been done|No task ran/);
		expect(render(result)).toContain(failures === 2 ? "✗" : "◐");
	});

	it("取消等待全部已启动进程 close，保留部分输出和未启动任务结果", async () => {
		const controller = new AbortController();
		const promise = execute(tasks(6), controller.signal);
		let settled = false;
		void promise.then(() => { settled = true; });
		for (let i = 0; i < 4; i++) send(processes[i], `部分${i}`);
		controller.abort();
		for (const proc of processes) expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		for (let i = 0; i < 3; i++) processes[i].close(null, "SIGTERM");
		await drain();
		expect(settled).toBe(false);
		expect(processes).toHaveLength(4);
		processes[3].close(null, "SIGTERM");
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.details.results).toHaveLength(6);
		expect(result.details.results.every((r) => r.status === "aborted")).toBe(true);
		for (let i = 0; i < 4; i++) expect(getFinalOutput(result.details.results[i].messages)).toBe(`部分${i}`);
		for (let i = 4; i < 6; i++) expect(result.details.results[i].messages).toEqual([]);
	});

	it("预取消仍为每个输入生成结果且不 spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await execute(tasks(6), controller.signal);
		expect(result.details.results).toHaveLength(6);
		expect(result.details.results.every((r) => r.status === "aborted")).toBe(true);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("某进程启动异常不提前返回或丢弃其他进程", async () => {
		mocks.spawn.mockImplementationOnce(() => { throw new Error("spawn failure"); });
		const promise = execute(tasks(2));
		let settled = false;
		void promise.then(() => { settled = true; });
		await drain();
		expect(settled).toBe(false);
		send(processes[0], "其他任务结果");
		processes[0].close();
		const result = await promise;
		expect(result.details.results.map((r) => r.status)).toEqual(["failed", "completed"]);
		expect(text(result)).toContain("其他任务结果");
	});
});

describe("参数和链式执行", () => {
	it.each([{}, { agent: "worker", task: "任务", tasks: [{ agent: "worker", task: "冲突" }] }, { tasks: Array.from({ length: 9 }, () => ({ agent: "worker", task: "任务" })) }])("无效参数或超限标记 isError", async (params) => {
		const result = await execute(params);
		expect(result.isError).toBe(true);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("未知 Agent 返回诊断且不启动", async () => {
		const result = await execute({ agent: "missing", task: "任务" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Available agents: \"worker\"");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("previous 中美元替换字符逐字保留，完整原文传给下一步", async () => {
		const previous = "$& $` $' $$ $1 {previous}\n" + "中".repeat(20_000);
		const promise = execute({ chain: [{ agent: "worker", task: "第一步" }, { agent: "worker", task: "前{previous}后{previous}" }] });
		send(processes[0], previous);
		processes[0].close();
		await drain();
		expect(mocks.spawn.mock.calls[1][1].at(-1)).toBe(`Task: 前${previous}后${previous}`);
		send(processes[1], "最终结果");
		processes[1].close();
		const result = await promise;
		expect(text(result)).toBe("最终结果");
		expect(getFinalOutput(result.details.results[0].messages)).toBe(previous);
	});

	it.each(["error", "aborted"])("退出码零但 stopReason=%s 时显示失败并停止后续步骤", async (stopReason) => {
		const promise = execute({ chain: [{ agent: "worker", task: "第一步" }, { agent: "worker", task: "不应执行" }] });
		send(processes[0], "部分结果", stopReason, "诊断");
		processes[0].close();
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(processes).toHaveLength(1);
		expect(text(result)).toContain("Chain stopped at step 1");
		expect(render(result)).toContain("✗");
		expect(render(result)).toContain("0/1 steps");
		expect(render(result, true)).toContain("诊断");
	});
});

describe("模型可见输出预算", () => {
	for (const mode of ["single", "chain", "parallel"] as const) {
		for (const limit of ["bytes", "lines"] as const) {
			it(`${mode} ${limit} 截断含提示不超预算，details 保留完整内容`, async () => {
				const output = limit === "bytes" ? ("中文😀".repeat(50) + "\n").repeat(200) : "中文😀\n".repeat(2500);
				const task = { agent: "worker", task: "任务" };
				const params = mode === "single" ? task : mode === "chain" ? { chain: [task] } : { tasks: [task, task] };
				const updates: Result[] = [];
				const promise = execute(params, undefined, (result) => { updates.push(structuredClone(result)); });
				for (const proc of processes) {
					send(proc, output);
					proc.close();
				}
				const result = await promise;
				const visible = text(result);
				expect(visible).toContain("[Output truncated:");
				expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(50 * 1024);
				expect(visible.split("\n").length).toBeLessThanOrEqual(2000);
				expect(visible).not.toContain("\uFFFD");
				for (const item of result.details.results) expect(getFinalOutput(item.messages)).toBe(output);
				for (const update of updates) {
					expect(Buffer.byteLength(text(update))).toBeLessThanOrEqual(50 * 1024);
					expect(text(update).split("\n").length).toBeLessThanOrEqual(2000);
				}
			});
		}
	}

	it.each(["bytes", "lines"])("恰好达到 %s 预算时不截断", async (limit) => {
		const output = limit === "bytes" ? "a".repeat(50 * 1024) : Array.from({ length: 2000 }, () => "中").join("\n");
		const promise = execute();
		send(processes[0], output);
		processes[0].close();
		expect(text(await promise)).toBe(output);
	});

	it("首行超字节预算时遵循宿主整行规则，仅返回截断提示", async () => {
		const promise = execute();
		const output = "😀".repeat(20_000);
		send(processes[0], output);
		processes[0].close();
		const result = await promise;
		expect(text(result)).toMatch(/^\[Output truncated:/);
		expect(getFinalOutput(result.details.results[0].messages)).toBe(output);
	});

	it.each(["single", "chain", "parallel"])("%s 失败诊断也受整体预算限制", async (mode) => {
		const task = { agent: "worker", task: "任务" };
		const promise = execute(mode === "single" ? task : mode === "chain" ? { chain: [task] } : { tasks: [task, task] });
		const diagnostic = "错误中文😀\n".repeat(10_000);
		for (const proc of processes) {
			proc.stderr.emit("data", Buffer.from(diagnostic));
			proc.close(1);
		}
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("[Output truncated:");
		expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(50 * 1024);
		expect(text(result).split("\n").length).toBeLessThanOrEqual(2000);
		for (const item of result.details.results) expect(item.stderr).toBe(diagnostic);
	});
});
