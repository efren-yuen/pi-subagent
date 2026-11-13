import { describe, expect, it } from "vitest";
import { formatAgentList, parseToolList, type AgentConfig } from "../src/agents.ts";
import {
	formatTokens,
	formatUsageStats,
	mapWithConcurrencyLimit,
	truncateParallelOutput,
} from "../src/index.ts";

describe("formatTokens", () => {
	it("千位以下原样输出", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	it("千位区间保留一位小数", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("万位以上取整为 k", () => {
		expect(formatTokens(10_000)).toBe("10k");
		expect(formatTokens(999_999)).toBe("1000k");
	});

	it("百万以上保留一位小数 M", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(1_500_000)).toBe("1.5M");
	});
});

describe("formatUsageStats", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	it("全零且无 model 时为空串", () => {
		expect(formatUsageStats(zero)).toBe("");
	});

	it("turns 按单复数输出", () => {
		expect(formatUsageStats({ ...zero, turns: 1 })).toBe("1 turn");
		expect(formatUsageStats({ ...zero, turns: 3 })).toBe("3 turns");
	});

	it("按固定顺序拼接各项", () => {
		expect(
			formatUsageStats(
				{
					input: 1200,
					output: 340,
					cacheRead: 5600,
					cacheWrite: 78,
					cost: 0.0123,
					contextTokens: 9000,
					turns: 2,
				},
				"deepseek-v4.1-flash",
			),
		).toBe("2 turns ↑1.2k ↓340 R5.6k W78 $0.0123 ctx:9.0k deepseek-v4.1-flash");
	});

	it("contextTokens 为 0 时省略", () => {
		expect(formatUsageStats({ ...zero, contextTokens: 0, cost: 0.5 })).toBe("$0.5000");
	});
});

describe("truncateParallelOutput", () => {
	it("未超限时原样返回", () => {
		const text = "a".repeat(1000);
		expect(truncateParallelOutput(text)).toBe(text);
	});

	it("超限时截断并给出省略提示", () => {
		const text = "a".repeat(60 * 1024);
		const result = truncateParallelOutput(text);
		expect(result).toContain("[Output truncated:");
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(50 * 1024);
	});

	it("多字节字符不产生乱码", () => {
		const text = "中".repeat(30_000);
		const result = truncateParallelOutput(text);
		expect(result).not.toContain("\uFFFD");
		expect(result.startsWith("中")).toBe(true);
	});

	it("emoji 在截断边界保持合法 UTF-8，提示计入单项预算", () => {
		const result = truncateParallelOutput("a" + "😀".repeat(20_000));
		expect(Buffer.from(result).toString("utf8")).toBe(result);
		expect(result).not.toContain("\uFFFD");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(50 * 1024);
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("空数组直接返回", async () => {
		await expect(mapWithConcurrencyLimit([], 4, async (x: number) => x)).resolves.toEqual([]);
	});

	it("保持结果顺序", async () => {
		const result = await mapWithConcurrencyLimit([3, 1, 2], 2, async (x) => {
			await new Promise((r) => setTimeout(r, x * 5));
			return x * 10;
		});
		expect(result).toEqual([30, 10, 20]);
	});

	it("并发数不超过限制", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active -= 1;
			return x;
		});
		expect(peak).toBe(2);
	});

	it("任务失败时整体 reject", async () => {
		await expect(
			mapWithConcurrencyLimit([1, 2], 2, async (x) => {
				if (x === 2) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
	});
});

describe("parseToolList", () => {
	it("逗号分隔字符串", () => {
		expect(parseToolList("read, bash ,grep")).toEqual(["read", "bash", "grep"]);
	});

	it("数组形式", () => {
		expect(parseToolList(["read", " bash "])).toEqual(["read", "bash"]);
	});

	it("过滤非字符串项", () => {
		expect(parseToolList(["read", 1, null, "bash"])).toEqual(["read", "bash"]);
	});

	it("无法识别的类型返回 undefined", () => {
		expect(parseToolList(42)).toBeUndefined();
		expect(parseToolList({ a: 1 })).toBeUndefined();
	});

	it("空串返回 undefined", () => {
		expect(parseToolList("")).toBeUndefined();
		expect(parseToolList([])).toBeUndefined();
	});
});

describe("formatAgentList", () => {
	function agent(name: string): AgentConfig {
		return {
			name,
			description: `${name} desc`,
			systemPrompt: "",
			source: "user",
			filePath: `/tmp/${name}.md`,
		};
	}

	it("空列表", () => {
		expect(formatAgentList([], 3)).toEqual({ text: "none", remaining: 0 });
	});

	it("超出上限时报告剩余数量", () => {
		const result = formatAgentList([agent("a"), agent("b"), agent("c")], 2);
		expect(result.text).toBe("a (user): a desc; b (user): b desc");
		expect(result.remaining).toBe(1);
	});

	it("未超出上限时 remaining 为 0", () => {
		expect(formatAgentList([agent("a")], 3)).toEqual({
			text: "a (user): a desc",
			remaining: 0,
		});
	});
});
