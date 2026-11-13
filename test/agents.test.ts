import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../src/agents.ts";
import extension from "../src/index.ts";

const isolated = vi.hoisted(() => ({ agentRoot: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, getAgentDir: () => isolated.agentRoot };
});

let root: string;
let cwd: string;
let userDir: string;
let projectDir: string;
function agent(dir: string, file: string, name = file, extra = "", body = "测试提示词") {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${file}.md`), `---\nname: ${name}\ndescription: 测试 Agent\n${extra}---\n${body}`);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	isolated.agentRoot = path.join(root, "user");
	userDir = path.join(isolated.agentRoot, "agents");
	cwd = path.join(root, "project", "nested");
	projectDir = path.join(root, "project", ".pi", "agents");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Agent 文件隔离", () => {
	it("坏 YAML 不阻断合法文件发现，也不输出坏内容", () => {
		agent(userDir, "good", "good", "tools: [read, bash]\nmodel: mock-model\n");
		fs.writeFileSync(path.join(userDir, "bad.md"), "---\nname: [broken\ndescription: 不应输出的配置\n---\n");
		const warn = vi.spyOn(console, "warn");
		const error = vi.spyOn(console, "error");
		const discovery = discoverAgents(cwd, "user");
		expect(discovery.agents).toHaveLength(1);
		expect(discovery.agents[0]).toMatchObject({ name: "good", tools: ["read", "bash"], model: "mock-model", source: "user", systemPrompt: "测试提示词" });
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("注册工具时发现坏配置也不导致扩展加载失败", () => {
		agent(userDir, "good");
		fs.writeFileSync(path.join(userDir, "bad.md"), "---\nname: [broken\n---\n");
		const registerTool = vi.fn();
		expect(() => extension({ registerTool } as unknown as ExtensionAPI)).not.toThrow();
		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool.mock.calls[0][0].description).toContain("good (user)");
	});

	it("错误字段类型、不存在的符号链接、非 md 和目录均跳过", () => {
		agent(userDir, "good", "good", "tools: read, bash\n");
		agent(userDir, "bad-type", "42");
		fs.writeFileSync(path.join(userDir, "ignored.txt"), "普通文件");
		fs.mkdirSync(path.join(userDir, "directory.md"));
		fs.symlinkSync(path.join(root, "missing.md"), path.join(userDir, "broken.md"));
		expect(discoverAgents(cwd, "user").agents.map((a) => a.name)).toEqual(["good"]);
	});

	it("合法符号链接保留原发现行为", () => {
		agent(root, "linked", "linked");
		fs.symlinkSync(path.join(root, "linked.md"), path.join(userDir, "linked.md"));
		expect(discoverAgents(cwd, "user").agents[0]).toMatchObject({ name: "linked", source: "user" });
	});
});

describe("作用域与覆盖规则保持不变", () => {
	it("user/project 分离，both 中项目同名覆盖用户", () => {
		agent(userDir, "shared", "shared", "", "用户提示词");
		agent(userDir, "user-only");
		agent(projectDir, "shared", "shared", "", "项目提示词");
		agent(projectDir, "project-only");
		expect(discoverAgents(cwd, "user").agents.map((a) => a.name).sort()).toEqual(["shared", "user-only"]);
		expect(discoverAgents(cwd, "project").agents.map((a) => a.name).sort()).toEqual(["project-only", "shared"]);
		const both = discoverAgents(cwd, "both");
		expect(both.projectAgentsDir).toBe(projectDir);
		expect(both.agents).toHaveLength(3);
		expect(both.agents.find((a) => a.name === "shared")).toMatchObject({ source: "project", systemPrompt: "项目提示词" });
	});

	it("坏项目配置不遮蔽合法用户同名 Agent", () => {
		agent(userDir, "shared");
		fs.writeFileSync(path.join(projectDir, "shared.md"), "---\nname: [bad\n---\n");
		expect(discoverAgents(cwd, "both").agents[0]).toMatchObject({ name: "shared", source: "user" });
	});

	it("只使用最近的项目 agents 目录，不合并祖先目录", () => {
		agent(projectDir, "parent");
		const nearest = path.join(cwd, ".pi", "agents");
		agent(nearest, "nearest");
		const discovery = discoverAgents(cwd, "project");
		expect(discovery.projectAgentsDir).toBe(nearest);
		expect(discovery.agents.map((a) => a.name)).toEqual(["nearest"]);
	});
});
