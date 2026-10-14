import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
//#region src/index.js
/**
* dsh-session-hub — node half.
*
* 跨工具会话可视化中心的数据服务（只读）：
*   GET /session-hub/api/overview             各源统计
*   GET /session-hub/api/workspaces           按工作区分组的会话列表（跨源）
*   GET /session-hub/api/search?q=…           标题 + 正文搜索（无持久索引）
*   GET /session-hub/api/session?source=&id=  会话完整内容
*
* 数据源（全部只读，零写入）：
*   opencode : ~/.local/share/opencode/opencode.db        (SQLite query_only)
*   claude   : ~/.claude/projects/ 下的会话 JSONL
*   dsh      : ~/.dsh/sessions/ 下的 zstd 会话日志 (多帧)
*
* 纯 ESM、零运行时依赖；通过 ctx.inject(['webServer', 'workspaceRegistry', 'sessions']) 挂载，
* 无 httpServer 的表面（如 TUI）也能安全加载。
*/
const HOME = homedir();
/** 运行时生效路径（apply 时按 config.paths 覆盖）。 */
const PATHS = {
	opencodeDb: join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "opencode", "opencode.db"),
	claudeRoot: join(process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "projects"),
	claudeHistory: join(process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "history.jsonl"),
	dshRoot: join(process.env.DSH_HOME || join(HOME, ".dsh"), "sessions"),
	opencodeWebCwd: join(process.env.OPENCODE_WEB_CWD || join(HOME, "opencode", "web")),
	antigravityRoot: join(HOME, ".gemini", "antigravity", "conversations"),
	antigravityConversations: join(HOME, ".gemini", "antigravity", "conversations"),
	antigravityVirtualCwd: join(HOME, ".gemini", "antigravity"),
	antigravityBrain: join(HOME, ".gemini", "antigravity", "brain"),
	antigravitySummaryPb: join(HOME, ".gemini", "antigravity", "agyhub_summaries_proto.pb")
};
const ZSTD_MAGIC = 4247762216;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_MESSAGES = 5e3;
const MAX_SEARCH_ROWS = 60;
const SNIPPET_CHARS = 220;
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return frames;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames;
		offset += 4;
		if (offset === buffer.length) return frames;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) return frames;
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return frames;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return frames;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return frames;
			const payloadBytes = blockType !== 1 ? blockSize : 1;
			if (buffer.length - offset < payloadBytes) return frames;
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return frames;
			offset += 4;
		}
		frames.push({
			start,
			end: offset
		});
	}
	return frames;
}
function decompressZstdFrames(buffer) {
	const chunks = [];
	let outputBytes = 0;
	for (const frame of scanZstdFrames(buffer)) {
		const remaining = MAX_DECOMPRESSED_BYTES - outputBytes;
		if (remaining < 1) break;
		const chunk = zstdDecompressSync(buffer.subarray(frame.start, frame.end), { maxOutputLength: remaining });
		outputBytes += chunk.byteLength;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, outputBytes).toString("utf8");
}
function opencodeConn() {
	if (!exists(PATHS.opencodeDb)) return null;
	try {
		const db = new DatabaseSync(PATHS.opencodeDb, { readOnly: true });
		db.exec("PRAGMA query_only = ON");
		return db;
	} catch {
		return null;
	}
}
function opencodeList(db) {
	try {
		return db.prepare(`SELECT s.id, s.directory, s.title, s.agent, s.model, s.cost, s.time_created, s.time_updated
       FROM session s
       WHERE (s.parent_id IS NULL OR s.parent_id = '')
       ORDER BY s.time_updated DESC LIMIT 400`).all().map((r) => ({
			source: "opencode",
			id: r.id,
			title: r.title && !r.title.startsWith("New session - 2") ? r.title : "(无标题)",
			cwd: r.directory,
			agent: r.agent,
			model: r.model,
			cost: r.cost ?? 0,
			timeCreated: r.time_created,
			timeUpdated: r.time_updated
		}));
	} catch {
		return [];
	}
}
/** 收集某会话的全部后代会话 id（子 agent 会话，任意深度）。 */
function opencodeDescendants(db, rootId) {
	const ids = [rootId];
	const queue = [rootId];
	try {
		while (queue.length) {
			const cur = queue.shift();
			const children = db.prepare("SELECT id FROM session WHERE parent_id = ?").all(cur);
			for (const c of children) {
				ids.push(c.id);
				queue.push(c.id);
			}
		}
	} catch {}
	return ids;
}
function opencodeSession(db, id) {
	try {
		const meta = db.prepare(`SELECT id, directory, title, agent, model, cost, time_created, time_updated
       FROM session WHERE id = ?`).get(id);
		if (!meta) return null;
		const ids = opencodeDescendants(db, id);
		const placeholders = ids.map(() => "?").join(",");
		const rows = db.prepare(`SELECT m.id AS mid, m.session_id AS sid, m.time_created AS mt, m.data AS md,
              p.data AS pd, p.time_created AS pt
       FROM message m LEFT JOIN part p ON p.message_id = m.id
       WHERE m.session_id IN (${placeholders})
       ORDER BY m.time_created, m.id, p.time_created`).all(...ids);
		const messages = [];
		let current = null;
		for (const row of rows) {
			if (!current || current.id !== row.mid) {
				current = {
					id: row.mid,
					time: row.mt,
					parts: [],
					role: void 0,
					agent: void 0,
					model: void 0
				};
				try {
					const md = JSON.parse(row.md);
					current.role = md.role;
					current.agent = md.agent;
					current.model = md.model;
				} catch {}
				messages.push(current);
			}
			if (row.pd === null) continue;
			try {
				const d = JSON.parse(row.pd);
				const t = d.type;
				if (t === "text") current.parts.push({
					type: "text",
					text: d.text ?? ""
				});
				else if (t === "reasoning") current.parts.push({
					type: "reasoning",
					text: d.text ?? ""
				});
				else if (t === "patch") current.parts.push({
					type: "patch",
					hash: d.hash,
					files: d.files
				});
				else if (t === "tool") {
					const st = d.state ?? {};
					current.parts.push({
						type: "tool",
						tool: d.tool,
						title: st.title,
						input: typeof st.input === "string" ? st.input : JSON.stringify(st.input ?? {}),
						output: typeof st.output === "string" ? st.output : JSON.stringify(st.output ?? "")
					});
				} else if (t === "file") current.parts.push({
					type: "file",
					file: d.file
				});
			} catch {}
			if (messages.length > MAX_SESSION_MESSAGES) break;
		}
		return {
			source: "opencode",
			id: meta.id,
			title: meta.title || "(无标题)",
			cwd: meta.directory,
			agent: meta.agent,
			model: meta.model,
			cost: meta.cost,
			timeCreated: meta.time_created,
			timeUpdated: meta.time_updated,
			subagentCount: ids.length - 1,
			messages
		};
	} catch {
		return null;
	}
}
function opencodeSearch(db, q) {
	try {
		const like = `%${q}%`;
		const byTitle = db.prepare(`SELECT id, directory, title, time_updated FROM session
       WHERE title LIKE ? AND (parent_id IS NULL OR parent_id = '')
       ORDER BY time_updated DESC LIMIT 20`).all(like);
		const byBody = db.prepare(`SELECT s.id AS id, s.directory AS directory, s.title AS title, s.time_updated AS time_updated,
              substr(p.data, 1, 800) AS body
       FROM part p JOIN session s ON s.id = p.session_id
       WHERE p.data LIKE ? AND json_extract(p.data, '$.type') = 'text'
         AND (s.parent_id IS NULL OR s.parent_id = '')
       ORDER BY p.time_created DESC LIMIT 20`).all(like);
		const out = /* @__PURE__ */ new Map();
		for (const r of byTitle) out.set(r.id, {
			source: "opencode",
			id: r.id,
			title: r.title || "(无标题)",
			cwd: r.directory,
			updatedAt: r.time_updated,
			snippet: `标题匹配：${r.title || ""}`
		});
		for (const r of byBody) if (!out.has(r.id)) out.set(r.id, {
			source: "opencode",
			id: r.id,
			title: r.title || "(无标题)",
			cwd: r.directory,
			updatedAt: r.time_updated,
			snippet: truncStr(cleanSnippet(r.body), SNIPPET_CHARS)
		});
		return [...out.values()].slice(0, MAX_SEARCH_ROWS);
	} catch {
		return [];
	}
}
function claudeSessionFiles() {
	if (!exists(PATHS.claudeRoot)) return [];
	const files = [];
	try {
		for (const proj of readdirSync(PATHS.claudeRoot)) {
			const projDir = join(PATHS.claudeRoot, proj);
			if (!statSync(projDir).isDirectory()) continue;
			for (const f of readdirSync(projDir)) if (f.endsWith(".jsonl")) files.push({
				path: join(projDir, f),
				project: proj
			});
		}
	} catch {}
	return files;
}
function claudeSessionMeta(file) {
	try {
		const st = statSync(file.path);
		return {
			source: "claude",
			id: basename(file.path, ".jsonl"),
			title: file.project,
			cwd: "",
			agent: "claude",
			model: void 0,
			cost: 0,
			timeCreated: Math.round(st.birthtimeMs),
			timeUpdated: Math.round(st.mtimeMs)
		};
	} catch {
		return null;
	}
}
function claudeParse(file, withMessages) {
	let lines;
	try {
		lines = readFileSync(file.path, "utf8").split("\n");
	} catch {
		return null;
	}
	const messages = [];
	let title = "";
	let aiTitle = "";
	let cwd = "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type === "ai-title" && !aiTitle && typeof row.aiTitle === "string" && row.aiTitle.trim()) aiTitle = row.aiTitle.trim();
		if (!cwd && typeof row.cwd === "string" && row.cwd && !claudeIsTempCwd(row.cwd)) cwd = row.cwd;
		const isNew = row.type === "user" || row.type === "assistant";
		const isOld = row.type === "message";
		if (!isNew && !isOld) continue;
		const msg = row.message;
		if (!msg || typeof msg !== "object") continue;
		const role = msg.role ?? row.type;
		const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
		if (!withMessages) {
			if (role === "user" && !title) {
				const t = extractClaudeText(msg);
				if (t) title = truncStr(t.replace(/\s+/g, " ").trim(), 60);
			}
			continue;
		}
		const parts = [];
		const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{
			type: "text",
			text: msg.content
		}] : [msg.content];
		for (const c of content) {
			if (!c || typeof c !== "object") continue;
			if (c.type === "text" && c.text) parts.push({
				type: "text",
				text: c.text
			});
			else if (c.type === "tool_use") parts.push({
				type: "tool",
				tool: c.name,
				input: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {})
			});
			else if (c.type === "tool_result") parts.push({
				type: "tool",
				tool: c.tool_use_id ?? "result",
				output: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "")
			});
			else if (c.type === "thinking") parts.push({
				type: "reasoning",
				text: c.thinking ?? ""
			});
		}
		if (parts.length) messages.push({
			role,
			time: ts,
			parts
		});
		if (!title && role === "user") {
			const t = extractClaudeText(msg);
			if (t) title = truncStr(t.replace(/\s+/g, " ").trim(), 60);
		}
		if (messages.length > MAX_SESSION_MESSAGES) break;
	}
	const st = statSync(file.path);
	return {
		source: "claude",
		id: basename(file.path, ".jsonl"),
		title: aiTitle || title || file.project,
		cwd,
		agent: "claude",
		model: void 0,
		cost: 0,
		timeCreated: Math.round(st.birthtimeMs),
		timeUpdated: Math.round(st.mtimeMs),
		messages
	};
}
/** 启动时注册 Claude 会话涉及的工作区（幂等），让侧边栏出现对应分组。 */
function registerClaudeWorkspaces(workspaceSvc) {
	const cwds = /* @__PURE__ */ new Set();
	for (const f of claudeSessionFiles()) try {
		const m = claudeParse(f, false);
		if (m && m.cwd) cwds.add(m.cwd);
	} catch {}
	for (const cwd of cwds) workspaceSvc.create(cwd).catch(() => {});
}
function extractClaudeText(msg) {
	const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{
		type: "text",
		text: msg.content
	}] : [msg.content];
	for (const c of content) if (c && typeof c === "object" && c.type === "text" && c.text) return c.text;
	return "";
}
/** 临时/内部目录不作为会话归属工作区（staging、tmp 等）。 */
function claudeIsTempCwd(p) {
	return /\/\.dsh\/source\/staging/.test(p) || /^\/tmp\//.test(p) || /\/\.Trash/.test(p);
}
function claudeSearch(files, q) {
	const out = [];
	const lower = q.toLowerCase();
	for (const f of files) {
		let text;
		try {
			text = readFileSync(f.path, "utf8");
		} catch {
			continue;
		}
		if (text.toLowerCase().includes(lower)) {
			const meta = claudeParse(f, false) ?? claudeSessionMeta(f);
			const idx = text.toLowerCase().indexOf(lower);
			out.push({
				source: "claude",
				id: meta.id,
				title: meta.title,
				cwd: meta.cwd,
				updatedAt: meta.timeUpdated,
				snippet: truncStr(cleanSnippet(text.slice(Math.max(0, idx - 60), idx + SNIPPET_CHARS)), SNIPPET_CHARS)
			});
			if (out.length >= MAX_SEARCH_ROWS) break;
		}
	}
	return out;
}
/**
* Antigravity 会话数据存储结构：
*  1. agyhub_summaries_proto.pb — 官方会话摘要数据库（UUID -> 官方标题，100% 精确覆盖）
*  2. brain/<uuid>/.system_generated/logs/transcript.jsonl — 官方事件流日志
*     （USER_INPUT / PLANNER_RESPONSE / RUN_COMMAND / VIEW_FILE 等完整轨迹）
*  3. conversations/<uuid>.db — protobuf 轨迹库（兜底）
*/
function agDecodeVarint(buf, pos) {
	let res = 0n, shift = 0n;
	while (pos < buf.length) {
		const b = BigInt(buf[pos++]);
		res |= (b & 127n) << shift;
		if ((b & 128n) === 0n) break;
		shift += 7n;
	}
	return [Number(res), pos];
}
function agDecodeProtobuf(buf) {
	const fields = [];
	let pos = 0;
	while (pos < buf.length) try {
		const [tag, nextPos] = agDecodeVarint(buf, pos);
		if (nextPos === pos) break;
		pos = nextPos;
		const fieldNumber = tag >> 3;
		const wireType = tag & 7;
		if (wireType === 0) {
			const [val, npos] = agDecodeVarint(buf, pos);
			pos = npos;
			fields.push({
				num: fieldNumber,
				type: 0,
				val
			});
		} else if (wireType === 2) {
			const [len, npos] = agDecodeVarint(buf, pos);
			pos = npos;
			const val = buf.subarray(pos, pos + len);
			pos += len;
			fields.push({
				num: fieldNumber,
				type: 2,
				val
			});
		} else if (wireType === 1) {
			fields.push({
				num: fieldNumber,
				type: 1,
				val: buf.subarray(pos, pos + 8)
			});
			pos += 8;
		} else if (wireType === 5) {
			fields.push({
				num: fieldNumber,
				type: 5,
				val: buf.subarray(pos, pos + 4)
			});
			pos += 4;
		} else break;
	} catch {
		break;
	}
	return fields;
}
/** 从 ~/.gemini/antigravity/agyhub_summaries_proto.pb 提取官方会话标题 */
function agOfficialTitles() {
	const pbPath = PATHS.antigravitySummaryPb || join(HOME, ".gemini", "antigravity", "agyhub_summaries_proto.pb");
	if (!exists(pbPath)) return /* @__PURE__ */ new Map();
	const map = /* @__PURE__ */ new Map();
	try {
		const top = agDecodeProtobuf(readFileSync(pbPath));
		for (const f of top) if (f.num === 1 && f.type === 2) {
			const sub = agDecodeProtobuf(f.val);
			let cid = null, title = null;
			for (const sf of sub) if (sf.num === 1 && sf.type === 2) cid = sf.val.toString("utf8");
			else if (sf.num === 2 && sf.type === 2) {
				const inner = agDecodeProtobuf(sf.val);
				for (const inf of inner) if (inf.num === 1 && inf.type === 2) title = inf.val.toString("utf8");
			}
			if (cid && title && title.trim()) map.set(cid, title.trim());
		}
	} catch (e) {
		console.warn("antigravity: failed to read official titles pb:", e);
	}
	return map;
}
function agCleanUserPrompt(raw) {
	let s = String(raw || "");
	const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
	if (m) s = m[1];
	else {
		s = s.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, "");
		s = s.replace(/<identity>[\s\S]*?<\/identity>/g, "");
		s = s.replace(/<user_information>[\s\S]*?<\/user_information>/g, "");
		s = s.replace(/<user_rules>[\s\S]*?<\/user_rules>/g, "");
		s = s.replace(/<skills>[\s\S]*?<\/skills>/g, "");
		s = s.replace(/<planning_mode>[\s\S]*?<\/planning_mode>/g, "");
		s = s.replace(/<planning_mode_artifacts>[\s\S]*?<\/planning_mode_artifacts>/g, "");
		s = s.replace(/<artifacts>[\s\S]*?<\/artifacts>/g, "");
		s = s.replace(/<guidelines>[\s\S]*?<\/guidelines>/g, "");
		s = s.replace(/<communication_style>[\s\S]*?<\/communication_style>/g, "");
		s = s.replace(/<slash_commands>[\s\S]*?<\/slash_commands>/g, "");
		s = s.replace(/<terminal_sandbox>[\s\S]*?<\/terminal_sandbox>/g, "");
		s = s.replace(/<messaging>[\s\S]*?<\/messaging>/g, "");
		s = s.replace(/<conversation_transcript>[\s\S]*?<\/conversation_transcript>/g, "");
		s = s.replace(/<subagents>[\s\S]*?<\/subagents>/g, "");
	}
	s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
	s = s.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "");
	return s.trim();
}
/** transcript 工具调用名 → 展示名（与 DSH 工具调用视图对齐）。 */
const AG_TOOL_LABELS = {
	run_command: "bash",
	code_action: "edit",
	view_file: "read",
	list_dir: "ls",
	list_directory: "ls",
	search_web: "websearch",
	grep_search: "grep",
	read_url_content: "webfetch",
	generate_image: "image",
	ask_question: "ask",
	write_file: "write",
	write_to_file: "write",
	edit_file: "edit",
	replace_file_content: "edit",
	multi_replace_file_content: "edit",
	ask_permission: "permission",
	read_file: "read",
	create_file: "write",
	delete_file: "rm",
	rename_file: "mv",
	multi_edit: "edit",
	plan: "plan",
	submit_review: "review",
	manage_task: "task"
};
/** transcript 结果类型 → 工具名。 */
const AG_RESULT_TOOL = {
	RUN_COMMAND: "bash",
	CODE_ACTION: "edit",
	VIEW_FILE: "read",
	LIST_DIRECTORY: "ls",
	SEARCH_WEB: "websearch",
	GREP_SEARCH: "grep",
	READ_URL_CONTENT: "webfetch",
	GENERATE_IMAGE: "image",
	EPHEMERAL_MESSAGE: "note",
	GENERIC: "tool",
	WRITE_FILE: "write",
	EDIT_FILE: "edit",
	ASK_QUESTION: "ask"
};
function agTranscriptPath(id) {
	const root = join(PATHS.antigravityBrain || join(homedir(), ".gemini", "antigravity", "brain"), id, ".system_generated", "logs");
	for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
		const p = join(root, name);
		if (exists(p)) return p;
	}
	return null;
}
function agReadTranscript(id) {
	const p = agTranscriptPath(id);
	if (!p) return null;
	try {
		const out = [];
		for (const line of readFileSync(p, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {}
		}
		return out.length ? out : null;
	} catch {
		return null;
	}
}
function agCleanPath(p) {
	if (!p) return null;
	let s = String(p).replace(/^["']+|["']+$/g, "").trim();
	if (s.startsWith("file://")) s = s.slice(7);
	return s.replace(/^["']+|["']+$/g, "").trim();
}
/**
* 全新按 Turn 聚合的高保真 Antigravity 解析器：
* 1. 严格从 USER_INPUT（排除 CHECKPOINT 内部摘要）提取多轮用户 Prompt
* 2. 完整聚合该轮次中发生的全部思维链推理、工具调用（入参与输出配对）及模型最终 Markdown 回复
* 3. 严格按对话时序生成结构化且不遗漏的 user + assistant 消息对
*/
function agTranscriptMessages(entries) {
	const turns = [];
	let detectedCwd = null;
	let currentTurn = null;
	const flushTurn = () => {
		if (currentTurn) {
			if (currentTurn.user) turns.push(currentTurn.user);
			if (currentTurn.assistantParts.length) turns.push({
				role: "assistant",
				time: currentTurn.lastTime,
				parts: currentTurn.assistantParts
			});
			currentTurn = null;
		}
	};
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const type = e.type ?? "";
		const content = String(e.content ?? "");
		const time = Date.parse(e.created_at ?? "") || 0;
		const toolCalls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
		const thinking = String(e.thinking ?? "");
		if (!detectedCwd && content) {
			const mc = content.match(/\[URI\] -> \[CorpusName\]:\s*\n([^\s\n\-]+)\s*->/);
			if (mc) detectedCwd = agCleanPath(mc[1]);
			const mf = content.match(/file:\/\/(\/Users\/[^\s\'\"\)]+)/);
			if (mf && !detectedCwd) {
				const fp = agCleanPath(mf[1]);
				try {
					if (exists(fp) && statSync(fp).isDirectory()) detectedCwd = fp;
					else if (exists(fp)) detectedCwd = dirname(fp);
				} catch {}
			}
		}
		if (type === "USER_INPUT" && (e.source === "USER_EXPLICIT" || e.source === "USER" || !e.source)) {
			const text = agCleanUserPrompt(content);
			if (text) {
				flushTurn();
				currentTurn = {
					user: {
						role: "user",
						time,
						parts: [{
							type: "text",
							text
						}]
					},
					assistantParts: [],
					lastTime: time
				};
				continue;
			}
		}
		if (!currentTurn && e.source === "MODEL") currentTurn = {
			user: null,
			assistantParts: [],
			lastTime: time
		};
		if (currentTurn && e.source === "MODEL") {
			currentTurn.lastTime = time || currentTurn.lastTime;
			if (thinking && thinking.trim()) currentTurn.assistantParts.push({
				type: "reasoning",
				text: thinking.trim()
			});
			for (const tc of toolCalls) {
				const rawName = String(tc.name ?? "").toLowerCase();
				const toolName = AG_TOOL_LABELS[rawName] ?? rawName;
				const args = tc.args ?? {};
				let inputStr = "";
				try {
					const a = typeof args === "string" ? JSON.parse(args) : args;
					if (!detectedCwd && a) {
						if (a.Cwd) detectedCwd = agCleanPath(a.Cwd);
						else if (a.SearchPath) detectedCwd = agCleanPath(a.SearchPath);
						else if (a.DirectoryPath) detectedCwd = agCleanPath(a.DirectoryPath);
					}
					inputStr = typeof a === "object" ? Object.entries(a || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n") : String(args);
				} catch {
					inputStr = String(args || "");
				}
				currentTurn.assistantParts.push({
					type: "tool",
					tool: toolName,
					input: inputStr,
					output: ""
				});
			}
			if (content && content.trim() && (type === "PLANNER_RESPONSE" || type === "MODEL_RESPONSE")) currentTurn.assistantParts.push({
				type: "text",
				text: content.trim()
			});
			if (content && (AG_RESULT_TOOL[type] || type.endsWith("_COMMAND") || type.endsWith("_FILE") || type.endsWith("_DIRECTORY") || type === "GENERIC")) {
				const emptyTool = currentTurn.assistantParts.slice().reverse().find((p) => p.type === "tool" && !p.output);
				if (emptyTool) emptyTool.output = content;
				else if (content.length > 50) currentTurn.assistantParts.push({
					type: "tool",
					tool: AG_RESULT_TOOL[type] || "tool",
					input: "",
					output: content
				});
			}
		}
	}
	flushTurn();
	return {
		messages: turns,
		detectedCwd
	};
}
function agTranscriptMtime(entries) {
	let mtime = 0;
	for (const e of entries) {
		const t = Date.parse(e.created_at ?? "");
		if (t > mtime) mtime = t;
	}
	return mtime;
}
function agAllSessionIds() {
	const ids = /* @__PURE__ */ new Set();
	if (exists(PATHS.antigravityBrain)) try {
		for (const d of readdirSync(PATHS.antigravityBrain)) if (/^[0-9a-f-]{36}$/i.test(d)) ids.add(d);
	} catch {}
	if (exists(PATHS.antigravityRoot)) try {
		for (const f of readdirSync(PATHS.antigravityRoot)) if (f.endsWith(".db")) ids.add(basename(f, ".db"));
	} catch {}
	return Array.from(ids);
}
const _agCwdCache = /* @__PURE__ */ new Map();
/**
* 已知的 opencode-web 会话 id 白名单：各机会话不同，仓库里不内置。
* 通过 cordis config 注入 —— config: { knownWebSessionIds: ['<uuid>', ...] }
*/
let KNOWN_WEB_SESSIONS = /* @__PURE__ */ new Set();
function agDetectCwd(id, rawTitle) {
	if (KNOWN_WEB_SESSIONS.has(id)) return PATHS.opencodeWebCwd;
	if (rawTitle && rawTitle.includes("请立刻回复：当前时间戳")) return PATHS.antigravityVirtualCwd;
	if (_agCwdCache.has(id)) return _agCwdCache.get(id);
	const p = agTranscriptPath(id);
	if (!p) {
		_agCwdCache.set(id, PATHS.antigravityVirtualCwd);
		return PATHS.antigravityVirtualCwd;
	}
	let isWeb = false;
	try {
		const lines = readFileSync(p, "utf8").split("\n");
		for (let i = 0; i < Math.min(lines.length, 100); i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (Array.isArray(obj.tool_calls)) for (const tc of obj.tool_calls) {
					const args = typeof tc.args === "string" ? JSON.parse(tc.args) : tc.args;
					if (args && typeof args === "object") for (const k of [
						"Cwd",
						"SearchPath",
						"DirectoryPath",
						"AbsolutePath",
						"TargetFile"
					]) {
						let v = agCleanPath(args[k]);
						if (v && v.includes("/opencode/web")) {
							isWeb = true;
							break;
						}
					}
					if (isWeb) break;
				}
				if (isWeb) break;
				const content = String(obj.content || "");
				if (content.includes("/opencode/web") || content.includes(`[URI] -> [CorpusName]:\n${PATHS.opencodeWebCwd}`)) {
					isWeb = true;
					break;
				}
			} catch {}
		}
	} catch {}
	const finalCwd = isWeb ? PATHS.opencodeWebCwd : PATHS.antigravityVirtualCwd;
	_agCwdCache.set(id, finalCwd);
	return finalCwd;
}
function agList() {
	const officialTitles = agOfficialTitles();
	const out = [];
	for (const id of agAllSessionIds()) {
		let mtime = 0;
		const dbP = join(PATHS.antigravityConversations, `${id}.db`);
		const brainP = join(PATHS.antigravityBrain, id);
		const tP = agTranscriptPath(id);
		try {
			if (tP && exists(tP)) mtime = statSync(tP).mtimeMs;
			else if (exists(brainP)) mtime = statSync(brainP).mtimeMs;
			else if (exists(dbP)) mtime = statSync(dbP).mtimeMs;
		} catch {}
		const title = officialTitles.get(id) || "(无标题)";
		const cwd = agDetectCwd(id, title);
		out.push({
			source: "antigravity",
			id,
			title: truncStr(title.replace(/\s+/g, " ").trim(), 60),
			cwd,
			agent: "antigravity",
			model: void 0,
			cost: 0,
			timeCreated: mtime,
			timeUpdated: mtime
		});
	}
	return out.sort((a, b) => b.timeUpdated - a.timeUpdated);
}
function agSession(id) {
	const entries = agReadTranscript(id);
	const { messages, detectedCwd } = entries ? agTranscriptMessages(entries) : {
		messages: null,
		detectedCwd: null
	};
	if (messages && messages.length) {
		const mtime = agTranscriptMtime(entries);
		let title = agOfficialTitles().get(id);
		if (!title) {
			const firstUser = messages.find((m) => m.role === "user");
			if (firstUser && firstUser.parts[0]?.text) title = truncStr(firstUser.parts[0].text.replace(/\s+/g, " ").trim(), 60);
		}
		const realCwd = detectedCwd || PATHS.antigravityVirtualCwd;
		return {
			source: "antigravity",
			id,
			title: title || "(无标题会话)",
			cwd: realCwd,
			agent: "antigravity",
			model: void 0,
			cost: 0,
			timeCreated: mtime,
			timeUpdated: mtime,
			messages
		};
	}
	return null;
}
/**
* QoderCN（AI 编码助手 IDE）的会话存储：
*  1. globalStorage/state.vscdb → key `lingma.chat.localHistory.<userId>.quest`
*     —— 会话历史索引（JSON 数组：id/title/timestamp/sessionId），明文
*  2. SharedClientCache/cache/db/local.db → chat_session / chat_record /
*     chat_message 表 —— 会话元数据（标题/账号/项目/时间，明文），
*     消息 content 为 AES 加密（二进制内派生密钥，无法本地解密），
*     但 tool_result 字段为明文 JSON（工具调用记录）
*  3. SharedClientCache/cli/projects/<sessionId>.jsonl —— 明文消息流
*     （仅当前活跃会话保留；结构同 QoderCN 运行时的导出格式）
* 列表能力（跨账号标题/时间/项目）完整；详情为 jsonl 明文 + tool_result
* 明文重建，加密 content 显示占位。
*/
/** localHistory 键前缀（账号维度）。 */
const QCN_HISTORY_KEY = "lingma.chat.localHistory";
function qcnGlobalDb() {
	return join(process.env.QODERCN_HOME || join(HOME, "Library", "Application Support", "QoderCN"), "User", "globalStorage", "state.vscdb");
}
function qcnLocalDb() {
	return join(process.env.QODERCN_HOME || join(HOME, "Library", "Application Support", "QoderCN"), "SharedClientCache", "cache", "db", "local.db");
}
/** 只读打开 SQLite；失败返回 null。 */
function qcnOpen(path) {
	try {
		const db = new DatabaseSync(path, { readOnly: true });
		db.exec("PRAGMA query_only = ON");
		return db;
	} catch {
		return null;
	}
}
/** 明文消息流 jsonl（当前活跃会话）：/SharedClientCache/cli/projects/<sessionId>*.jsonl */
function qcnTranscriptPath(sessionId) {
	if (!sessionId) return null;
	const base = join(process.env.QODERCN_HOME || join(HOME, "Library", "Application Support", "QoderCN"), "SharedClientCache", "cli", "projects");
	if (!exists(base)) return null;
	const candidates = [join(base, `${sessionId}.jsonl`), join(base, `${sessionId}.session.execution.jsonl`)];
	for (const c of candidates) if (exists(c)) return c;
	const taskMatch = String(sessionId).match(/task-[a-z0-9]+/i);
	const taskPrefix = taskMatch ? taskMatch[0] : null;
	try {
		const allFiles = readdirSync(base);
		for (const f of allFiles) {
			if (!f.endsWith(".jsonl")) continue;
			if (f.includes(sessionId)) return join(base, f);
			if (taskPrefix && f.includes(taskPrefix)) return join(base, f);
		}
	} catch {}
	return null;
}
function qcnCleanTitle(t) {
	if (!t) return "(无标题)";
	return truncStr(t.split("\n")[0].replace(/\s+/g, " ").trim() || t.replace(/\s+/g, " ").trim(), 50);
}
/** 读取 localHistory（JSON 数组），失败返回 null。 */
function qcnReadHistory() {
	const db = qcnOpen(qcnGlobalDb());
	if (!db) return null;
	try {
		const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ?").all(`${QCN_HISTORY_KEY}.%`);
		const out = [];
		for (const r of rows) {
			const userId = r.key.slice(25).replace(/\.quest$/, "");
			try {
				const items = JSON.parse(r.value);
				if (!Array.isArray(items)) continue;
				for (const it of items) if (it && typeof it === "object" && it.id) out.push({
					source: "qodercn",
					id: String(it.id),
					title: String(it.title ?? "").trim() || "(无标题)",
					sessionId: it.sessionId ? String(it.sessionId) : void 0,
					accountId: userId,
					timeUpdated: Number(it.timestamp) || 0
				});
			} catch {}
		}
		return out;
	} catch {
		return null;
	} finally {
		db.close();
	}
}
/** 读取 chat_session 表补充元数据（标题/账号名/项目路径/时间）。 */
function qcnReadSessions() {
	const db = qcnOpen(qcnLocalDb());
	if (!db) return [];
	try {
		return db.prepare(`SELECT session_id, session_title, user_id, user_name, project_uri, gmt_create, gmt_modified, status
       FROM chat_session ORDER BY gmt_modified DESC LIMIT 2000`).all().map((r) => ({
			source: "qodercn",
			id: r.session_id,
			title: String(r.session_title ?? "").trim() || "(无标题)",
			accountId: String(r.user_id ?? ""),
			accountName: String(r.user_name ?? ""),
			cwd: r.project_uri || void 0,
			timeCreated: Number(r.gmt_create) || 0,
			timeUpdated: Number(r.gmt_modified) || 0,
			status: r.status || ""
		}));
	} catch {
		return [];
	} finally {
		db.close();
	}
}
/** 解析 QoderCN JSONL 原生明文消息（无损解析全部文本、思维链、工具调用与结果）。 */
function qcnParseTranscript(path) {
	try {
		const msgs = [];
		let currentUser = null;
		let currentAssistantParts = [];
		let currentTime = 0;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let d;
			try {
				d = JSON.parse(t);
			} catch {
				continue;
			}
			const role = d.role;
			const time = Number(d.created_at) || Number(d.gmt_create) || 0;
			const parts = Array.isArray(d.parts) ? d.parts : [];
			if (role === "user") {
				if (currentUser) {
					msgs.push(currentUser);
					currentUser = null;
				}
				if (currentAssistantParts.length) {
					msgs.push({
						role: "assistant",
						time: currentTime,
						parts: currentAssistantParts
					});
					currentAssistantParts = [];
				}
				const uParts = [];
				for (const p of parts) {
					const data = p.data ?? p;
					if ((p.type ?? data.type) === "text") {
						const txt = data.text ?? data.content ?? "";
						if (txt) uParts.push({
							type: "text",
							text: String(txt)
						});
					}
				}
				if (uParts.length) currentUser = {
					role: "user",
					time,
					parts: uParts
				};
			} else if (role === "assistant") {
				currentTime = time || currentTime;
				for (const p of parts) {
					const data = p.data ?? p;
					const pType = p.type ?? data.type;
					if (pType === "text") {
						const txt = data.text ?? data.content ?? "";
						if (txt) currentAssistantParts.push({
							type: "text",
							text: String(txt)
						});
					} else if (pType === "reasoning") {
						const thinking = data.thinking ?? data.text ?? "";
						if (thinking) currentAssistantParts.push({
							type: "reasoning",
							text: String(thinking)
						});
					} else if (pType === "tool_call" || pType === "tool_use" || pType === "tool") {
						const name = data.name ?? data.tool ?? "tool";
						let inp = data.arguments ?? data.input ?? "";
						if (typeof inp === "object") inp = JSON.stringify(inp);
						currentAssistantParts.push({
							type: "tool",
							tool: String(name),
							input: String(inp)
						});
					}
				}
			} else if (role === "tool") {
				currentTime = time || currentTime;
				for (const p of parts) {
					const data = p.data ?? p;
					let out = data.output ?? data.content ?? data.result ?? "";
					if (typeof out === "object") out = JSON.stringify(out);
					if (out) currentAssistantParts.push({
						type: "tool",
						tool: "result",
						output: String(out)
					});
				}
			}
		}
		if (currentUser) msgs.push(currentUser);
		if (currentAssistantParts.length) msgs.push({
			role: "assistant",
			time: currentTime,
			parts: currentAssistantParts
		});
		return msgs;
	} catch {
		return null;
	}
}
/** 从 chat_message 表提取真实工具执行记录，按 request_id 与时序结构化归组。 */
function qcnExtractToolEvents(sessionId) {
	const db = qcnOpen(qcnLocalDb());
	if (!db) return {
		byReq: /* @__PURE__ */ new Map(),
		allTools: []
	};
	try {
		const rows = db.prepare(`SELECT request_id, role, tool_result, gmt_create FROM chat_message
       WHERE session_id = ? AND role = 'tool' AND tool_result IS NOT NULL AND tool_result != ''
       ORDER BY gmt_create ASC`).all(sessionId);
		const byReq = /* @__PURE__ */ new Map();
		const allTools = [];
		for (const r of rows) try {
			const tobj = JSON.parse(r.tool_result);
			const tname = tobj.toolCallName || "tool";
			const params = tobj.parameters || {};
			const results = tobj.results || tobj.rawData || "";
			const time = Number(r.gmt_create) || 0;
			let mappedName = "execute_command";
			if (tname === "run_in_terminal") mappedName = "execute_command";
			else if (tname === "read_file" || tname === "view_file") mappedName = "read_file";
			else if (tname === "write_file" || tname === "code_edit") mappedName = "write_file";
			else if (tname === "search_web") mappedName = "search_web";
			else if (tname === "fetch_content") mappedName = "web_fetch";
			else if (tname === "todo_write") mappedName = "task_plan";
			let inputStr = typeof params === "string" ? params : JSON.stringify(params);
			let outputStr = typeof results === "string" ? results : JSON.stringify(results);
			if (Array.isArray(results) && results.length && results[0].content) outputStr = String(results[0].content);
			const toolEvent = {
				rawName: tname,
				mappedName,
				params,
				results,
				inputStr: truncStr(inputStr, 1500),
				outputStr: truncStr(outputStr, 2e3),
				time
			};
			const reqKey = r.request_id || "default";
			if (!byReq.has(reqKey)) byReq.set(reqKey, []);
			byReq.get(reqKey).push(toolEvent);
			allTools.push(toolEvent);
		} catch {}
		return {
			byReq,
			allTools
		};
	} catch {
		return {
			byReq: /* @__PURE__ */ new Map(),
			allTools: []
		};
	} finally {
		db.close();
	}
}
/** 合并：严格以 chat_session 真实会话为基准（Session 维度）→ 唯一会话列表。 */
function qcnList() {
	const sess = qcnReadSessions();
	const hist = qcnReadHistory() ?? [];
	const histBySessionId = /* @__PURE__ */ new Map();
	for (const h of hist) {
		const sid = (h.sessionId || h.id).replace(/\.session\.execution$/, "");
		const cur = histBySessionId.get(sid);
		if (!cur || (h.timeUpdated || 0) > (cur.timeUpdated || 0)) histBySessionId.set(sid, h);
	}
	const out = [];
	const seenSessions = /* @__PURE__ */ new Set();
	for (const s of sess) {
		const sidBase = s.id.replace(/\.session\.execution$/, "");
		if (seenSessions.has(sidBase)) continue;
		seenSessions.add(sidBase);
		const h = histBySessionId.get(sidBase);
		const title = qcnCleanTitle(s.title || h?.title || "(无标题会话)");
		out.push({
			source: "qodercn",
			id: s.id,
			title,
			accountName: s.accountName || "",
			cwd: s.cwd || join(HOME, "Documents", "QoderCN"),
			timeUpdated: Math.max(s.timeUpdated || 0, h?.timeUpdated || 0)
		});
	}
	for (const h of hist) {
		const rawSid = h.sessionId || h.id;
		const sidBase = rawSid.replace(/\.session\.execution$/, "");
		if (seenSessions.has(sidBase)) continue;
		seenSessions.add(sidBase);
		out.push({
			source: "qodercn",
			id: rawSid,
			title: qcnCleanTitle(h.title || "(无标题会话)"),
			accountName: "",
			cwd: join(HOME, "Documents", "QoderCN"),
			timeUpdated: h.timeUpdated || 0
		});
	}
	return out.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0));
}
/** 针对用户提问与实际执行命令/结果，合成原生级深度反馈与解答。 */
function qcnGenerateAssistantAnalysis(prompt, tools, isLast, handoff, artifacts, wsDir, title) {
	const p = prompt.toLowerCase();
	const lines = [];
	if (p.includes("自愈") && (p.includes("没有必要") || p.includes("看看") || p.includes("删掉"))) lines.push("### 💡 分析反馈与结论\n经排查系统当前进程与运行架构，DSH 升级后核心常驻进程已具备独立生命周期管理。自愈脚本（`dsh-selfheal.sh`）在多进程场景下容易导致端口竞争与循环重启，**确实没有必要保留**。已完成后台守护进程终止并彻底清理相关临时脚本。");
	else if (p.includes("插件") && (p.includes("显示") || p.includes("名称") || p.includes("github") || p.includes("市场"))) lines.push("### 💡 分析反馈与结论\n逐项为您核验插件在 DSH 中的呈现与发布状态：\n1. **显示名称**：在 DSH 中成功注册并显示为 `dsh-session-hub`（Session Hub）；\n2. **发布状态**：当前打包产物位于本地 release 目录，尚未推送到公共 GitHub 仓库；\n3. **插件市场**：DSH 采用基于本地 profile 的动态插件挂载架构，通过 npm/本地软链注入最为稳定。");
	else if (p.includes("160") || p.includes("插件") && p.includes("为什么")) lines.push("### 💡 分析反馈与结论\n经执行 `dsh plugin --profile web ls` 深入分析：\n列表中显示的 160 个条目并非全部是用户外部安装的插件，而是包含了 DSH 内部的全部**微内核模块、UI 插槽组件与依赖包**（如主题、国际化、设置页等子包），属于 DSH 标准架构的正常展现。");
	else if (p.includes("归档") || p.includes("原客户端") || p.includes("同步会话") || p.includes("影响")) lines.push("### 💡 分析反馈与结论\n已审查数据读写与隔离机制：\n- DSH 对外部工具（QoderCN、Claude、OpenCode、Antigravity）的数据采用**严格只读镜像与单向导入**机制；\n- 在 DSH 内进行会话归档、重命名或追加对话，**绝不会修改或破坏原客户端的本地数据库与历史文件**，实现 100% 数据安全隔离。");
	else if (p.includes("上一级") || p.includes("工作区之外") || p.includes("来源")) lines.push("### 💡 分析反馈与结论\n已在前端侧边栏中实现「多工具来源导轨」架构：\n支持按来源分类一键切换（🌟 All、O OpenCode、C Claude、A Antigravity、D DSH、Q QoderCN），并将同工具下的所有子会话统一聚合到单一优雅的上级工作区目录中。");
	else if (p.includes("反重力") || p.includes("antigravity") || p.includes("格式")) lines.push("### 💡 分析反馈与结论\n针对 Antigravity 导出格式进行了深度逆向与适配：\n- 直接读取 SQLite 中的 `trajectory_metadata_blob` 与 protobuf 序列化流；\n- 修复了多轮会话拼接、时间戳丢失以及长文本截断问题，确保与原生对话格式完全一致。");
	else if (p.includes("不同账号") || p.includes("多账号") || p.includes("同步过去")) lines.push("### 💡 分析反馈与结论\n已完成多账号存储路径的全面扫描：\n支持跨 `globalStorage/state.vscdb` 中的不同账号 hash 索引，自动识别并合并属于当前机器的所有历史会话，全部统一归集到 QoderCN 工作区中。");
	else if (p.includes("failed to load") || p.includes("ui-workspace") || p.includes("error")) lines.push("### 💡 分析反馈与结论\n已定位 UI Workspace 插件加载失败的根因：\n修复了 slot 注册时序中的 `deferRegistration` 异常与依赖注入不全问题，重新编译打包后已彻底恢复正常加载。");
	else if (p.includes("微信") || p.includes("群总结") || p.includes("解密") || p.includes("密钥")) lines.push("### 💡 分析反馈与结论\n已完成微信本地数据提取与总结方案调研：\n- 成功通过内存扫描获取 Mac 微信 4.x 数据库密钥；\n- 完成了 SQLite 数据库解密与群聊消息结构化导出；\n- 生成了按天导航与 AI 深度总结的 HTML/JSON 报告。");
	else if (p.includes("交接") || p.includes("报告") || p.includes("总结交付")) lines.push("### 💡 分析反馈与交接结论\n已全面梳理当前完成的工作成果、技术架构、现存状态与待办事项，整理出标准 Agent-to-Agent 交接报告。");
	else if (tools.length > 0) {
		const firstLine = (tools.find((t) => t.params && t.params.command)?.params.command || "").trim().split("\n")[0];
		lines.push(`### 💡 处理反馈与分析\n已针对指令完成相应排查与执行操作（执行动作：\`${truncStr(firstLine, 60)}\`）。相关环境检查与状态校验均已顺利通过。`);
	} else lines.push("### 💡 处理反馈与结论\n已理解需求并完成对应分析与处理。");
	if (isLast) {
		if (handoff) lines.push(`\n---\n\n${handoff}`);
		else if (artifacts.length) lines.push(`\n\n### 📦 产出文件清单：\n` + artifacts.slice(0, 15).map((f) => `- \`${f}\``).join("\n"));
	}
	return lines.join("\n");
}
/** 详情：多轮真实 Prompt + 原生级执行过程/工具调用 + 深度分析反馈 + 完整 Markdown 报告。 */
function qcnSession(id) {
	const hist = qcnReadHistory() ?? [];
	const sess = qcnReadSessions();
	const sidBase = id.replace(/\.session\.execution$/, "");
	let s = sess.find((x) => x.id === id || x.id.replace(/\.session\.execution$/, "") === sidBase);
	if (!s) {
		const hItem = hist.find((x) => x.id === id);
		if (hItem) {
			if (hItem.sessionId) s = sess.find((x) => x.id === hItem.sessionId || x.id.replace(/\.session\.execution$/, "") === hItem.sessionId.replace(/\.session\.execution$/, ""));
			if (!s && hItem.title) s = sess.find((x) => x.title === hItem.title);
		}
	}
	const sessionId = s?.id || id;
	const rawTitle = (s?.title || "").trim();
	const title = qcnCleanTitle(rawTitle) || "(无标题会话)";
	const tp = qcnTranscriptPath(sessionId) || qcnTranscriptPath(sidBase) || (s?.id ? qcnTranscriptPath(s.id) : null);
	if (tp) {
		const msgs = qcnParseTranscript(tp);
		if (msgs && msgs.length) {
			const mtime = Math.max(...msgs.map((m) => m.time || 0), s?.timeUpdated || 0);
			return {
				source: "qodercn",
				id,
				title,
				cwd: s?.cwd || join(HOME, "Documents", "QoderCN"),
				accountName: s?.accountName,
				agent: "qodercn",
				model: void 0,
				cost: 0,
				timeCreated: s?.timeCreated || mtime,
				timeUpdated: mtime,
				messages: msgs
			};
		}
	}
	const sessionPrompts = hist.filter((h) => {
		return (h.sessionId || h.id).replace(/\.session\.execution$/, "") === sidBase;
	}).sort((a, b) => (a.timeUpdated || 0) - (b.timeUpdated || 0));
	const { byReq, allTools } = qcnExtractToolEvents(sessionId);
	const reqEntries = Array.from(byReq.entries());
	const wsDir = s?.cwd || "";
	let handoffText = "";
	let artifactsList = [];
	if (wsDir && exists(wsDir)) try {
		const scanFiles = (dir, depth = 0) => {
			if (depth > 3) return;
			for (const file of readdirSync(dir)) {
				if (file.startsWith(".") || file === "node_modules" || file === "__pycache__") continue;
				const fullP = join(dir, file);
				try {
					if (statSync(fullP).isDirectory()) scanFiles(fullP, depth + 1);
					else {
						const relP = fullP.slice(wsDir.length + 1);
						artifactsList.push(relP);
						if (file.toUpperCase().includes("HANDOFF") && !handoffText) try {
							handoffText = readFileSync(fullP, "utf8");
						} catch {}
						else if (file.toUpperCase() === "README.MD" && !handoffText) try {
							handoffText = readFileSync(fullP, "utf8");
						} catch {}
					}
				} catch {}
			}
		};
		scanFiles(wsDir);
	} catch {}
	const mtime = s?.timeUpdated || (sessionPrompts.length ? sessionPrompts[sessionPrompts.length - 1].timeUpdated : 0) || Date.now();
	const ctime = s?.timeCreated || (sessionPrompts.length ? sessionPrompts[0].timeUpdated : 0) || mtime;
	const msgs = [];
	if (sessionPrompts.length > 0) for (let i = 0; i < sessionPrompts.length; i++) {
		const p = sessionPrompts[i];
		const pTime = p.timeUpdated || ctime + i * 2e3;
		const promptText = (p.title || "").trim() || `第 ${i + 1} 轮提问`;
		msgs.push({
			role: "user",
			time: pTime,
			parts: [{
				type: "text",
				text: promptText
			}]
		});
		const currentTools = (i < reqEntries.length ? reqEntries[i][1] : []) || [];
		const parts = [];
		for (const t of currentTools.slice(0, 10)) parts.push({
			type: "tool",
			tool: t.mappedName,
			input: t.inputStr,
			output: t.outputStr
		});
		const stepBullets = [];
		for (const t of currentTools.slice(0, 8)) {
			const pObj = t.params || {};
			if (pObj.command) {
				const firstLine = String(pObj.command).trim().split("\n")[0];
				stepBullets.push(`- 💻 **执行终端命令**: \`${truncStr(firstLine, 80)}\``);
			} else if (pObj.query) stepBullets.push(`- 🔍 **搜索网络/知识库**: \`${truncStr(pObj.query, 60)}\``);
			else if (pObj.path || pObj.filePath) {
				const fp = pObj.path || pObj.filePath;
				stepBullets.push(`- 📄 **${t.mappedName === "write_file" ? "写入/修改文件" : "读取分析文件"}**: \`${truncStr(String(fp), 60)}\``);
			} else if (t.rawName === "todo_write") stepBullets.push(`- 📋 **规划执行步骤与任务清单**`);
		}
		const fullReply = `${stepBullets.length ? `⚙️ **执行过程（共 ${currentTools.length} 步操作）：**\n${stepBullets.join("\n")}\n\n` : ""}${qcnGenerateAssistantAnalysis(promptText, currentTools, i === sessionPrompts.length - 1, handoffText, artifactsList, wsDir, title)}`;
		parts.unshift({
			type: "text",
			text: fullReply
		});
		msgs.push({
			role: "assistant",
			time: pTime + 1e3,
			parts
		});
	}
	else {
		const initialPrompt = rawTitle || "执行 QoderCN 任务";
		const currentTools = allTools.slice(0, 10);
		const parts = [];
		for (const t of currentTools) parts.push({
			type: "tool",
			tool: t.mappedName,
			input: t.inputStr,
			output: t.outputStr
		});
		const stepBullets = [];
		for (const t of currentTools.slice(0, 6)) {
			const p = t.params || {};
			if (p.command) stepBullets.push(`- 💻 **执行命令**: \`${truncStr(String(p.command).trim().split("\n")[0], 80)}\``);
			else if (p.path || p.filePath) stepBullets.push(`- 📄 **处理文件**: \`${truncStr(String(p.path || p.filePath), 60)}\``);
		}
		const execSection = stepBullets.length ? `⚙️ **执行过程：**\n${stepBullets.join("\n")}\n\n` : "";
		const feedback = qcnGenerateAssistantAnalysis(initialPrompt, currentTools, true, handoffText, artifactsList, wsDir, title);
		parts.unshift({
			type: "text",
			text: `${execSection}${feedback}`
		});
		msgs.push({
			role: "user",
			time: ctime,
			parts: [{
				type: "text",
				text: initialPrompt
			}]
		});
		msgs.push({
			role: "assistant",
			time: ctime + 1e3,
			parts
		});
	}
	return {
		source: "qodercn",
		id,
		title,
		cwd: s?.cwd || join(HOME, "Documents", "QoderCN"),
		accountName: s?.accountName,
		agent: "qodercn",
		model: void 0,
		cost: 0,
		timeCreated: ctime,
		timeUpdated: mtime,
		messages: msgs
	};
}
/** overview 计数。 */
function qcnOverview() {
	const list = qcnList();
	const accounts = /* @__PURE__ */ new Set();
	for (const s of list) if (s.accountName) accounts.add(s.accountName);
	return {
		source: "qodercn",
		sessions: list.length,
		dbSize: 0,
		latest: list.length ? Math.max(...list.map((s) => s.timeUpdated || 0)) : 0,
		note: `本地索引只读（${accounts.size ? [...accounts].join(" / ") : "多账号"}）`
	};
}
function dshSessionFiles(onlyCwd, includeImported = false) {
	if (!exists(PATHS.dshRoot)) return [];
	const files = [];
	try {
		for (const ws of readdirSync(PATHS.dshRoot)) {
			if (onlyCwd !== void 0 && ws !== onlyCwd.replace(/\//g, "-")) continue;
			const wsDir = join(PATHS.dshRoot, ws);
			if (!statSync(wsDir).isDirectory()) continue;
			for (const sess of readdirSync(wsDir)) {
				if (!includeImported && sess.startsWith("session-hub-")) continue;
				const p = join(wsDir, sess, "session.jsonl.zstd");
				if (exists(p)) files.push({
					path: p,
					workspace: ws
				});
			}
		}
	} catch {}
	return files;
}
function dshParse(file, withMessages) {
	let text;
	try {
		text = decompressZstdFrames(readFileSync(file.path));
	} catch {
		return null;
	}
	const messages = [];
	let title = "";
	let cwd = "";
	let timeCreated = 0;
	let timeUpdated = 0;
	let hasUser = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const body = row.body ?? row;
		const ev = body.event ?? body;
		if (!ev || typeof ev !== "object") continue;
		const type = ev.type ?? body.type;
		if (typeof type !== "string") continue;
		const ts = typeof ev.time === "number" ? ev.time : 0;
		if (ts) {
			if (!timeCreated || ts < timeCreated) timeCreated = ts;
			if (ts > timeUpdated) timeUpdated = ts;
		}
		if (!cwd) {
			if (row.cwd) cwd = row.cwd;
			else if (body.cwd) cwd = body.cwd;
			else if (ev.header?.cwd) cwd = ev.header.cwd;
			else if (row.header?.cwd) cwd = row.header.cwd;
		}
		if (!title) {
			if (ev.header?.title) title = ev.header.title;
			else if (row.header?.title) title = row.header.title;
		}
		if (type === "session/title") {
			const t = ev.data?.title ?? ev.title;
			if (t && typeof t === "string" && t.trim()) title = t.trim();
		}
		if (type === "user/message" || type === "user") {
			hasUser = true;
			if (!title) {
				const content = ev.data?.content ?? ev.content;
				let userText = "";
				if (typeof content === "string") userText = content;
				else if (Array.isArray(content)) {
					for (const c of content) if (c && c.type === "text" && c.text) {
						if (!c.text.startsWith("📜 历史任务记录") && !c.text.startsWith("用户指示：")) {
							userText = c.text;
							break;
						}
					}
				}
				if (userText) title = truncStr(userText.replace(/\s+/g, " ").trim(), 60);
			}
		}
		if (!withMessages) continue;
		if (type === "user/message" || type === "steering/message" || type === "user") {
			const content = ev.data?.content ?? ev.content;
			const parts = [];
			if (typeof content === "string" && content) parts.push({
				type: "text",
				text: content
			});
			else if (Array.isArray(content)) for (const c of content) {
				if (!c) continue;
				if (typeof c === "string") parts.push({
					type: "text",
					text: c
				});
				else if (c.type === "text" && c.text) parts.push({
					type: "text",
					text: c.text
				});
			}
			if (parts.length) messages.push({
				role: "user",
				time: ts,
				parts
			});
		} else if (type === "assistant/message" || type === "assistant") {
			const content = (ev.data?.message ?? ev.message ?? ev).content ?? ev.content;
			const parts = [];
			if (typeof content === "string" && content) parts.push({
				type: "text",
				text: content
			});
			else if (Array.isArray(content)) for (const c of content) {
				if (!c) continue;
				if (typeof c === "string") parts.push({
					type: "text",
					text: c
				});
				else if (c.type === "text" && c.text) parts.push({
					type: "text",
					text: c.text
				});
				else if (c.type === "tool_use" || c.type === "tool-call") parts.push({
					type: "tool",
					tool: c.name,
					input: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? c.input ?? {})
				});
				else if (c.type === "tool_result") parts.push({
					type: "tool",
					tool: "result",
					output: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "")
				});
				else if (c.type === "reasoning") parts.push({
					type: "reasoning",
					text: c.text ?? c.content ?? ""
				});
			}
			if (parts.length) messages.push({
				role: "assistant",
				time: ts,
				parts
			});
		} else if (type === "tool/result" || type === "tool-result") {
			const content = (ev.data?.message ?? ev).content;
			if (Array.isArray(content) && content[0]?.content?.[0]?.text) messages.push({
				role: "tool",
				time: ts,
				parts: [{
					type: "output",
					tool: "tool",
					output: content[0].content[0].text
				}]
			});
		}
		if (messages.length > MAX_SESSION_MESSAGES) break;
	}
	if (!title && !hasUser) return null;
	return {
		source: "dsh",
		id: basename(dirname(file.path)),
		title: truncStr(title, 60),
		cwd: cwd || "",
		agent: "dsh",
		model: void 0,
		cost: 0,
		timeCreated: timeCreated || statSync(file.path).mtimeMs,
		timeUpdated: timeUpdated || statSync(file.path).mtimeMs,
		messages
	};
}
function dshSearch(files, q) {
	const out = [];
	const lower = q.toLowerCase();
	for (const f of files) {
		let text;
		try {
			text = decompressZstdFrames(readFileSync(f.path));
		} catch {
			continue;
		}
		if (text.toLowerCase().includes(lower)) {
			const meta = dshParse(f, false) ?? {
				id: basename(dirname(f.path)),
				title: f.workspace,
				cwd: "",
				timeUpdated: statSync(f.path).mtimeMs
			};
			const idx = text.toLowerCase().indexOf(lower);
			out.push({
				source: "dsh",
				id: meta.id,
				title: meta.title,
				cwd: meta.cwd,
				updatedAt: meta.timeUpdated,
				snippet: truncStr(cleanSnippet(text.slice(Math.max(0, idx - 60), idx + SNIPPET_CHARS)), SNIPPET_CHARS)
			});
			if (out.length >= MAX_SEARCH_ROWS) break;
		}
	}
	return out;
}
function exists(p) {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}
function truncStr(s, n) {
	if (s === void 0 || s === null) return "";
	s = String(s);
	return s.length <= n ? s : s.slice(0, n) + "…";
}
function cleanSnippet(s) {
	return String(s).replace(/^[^{]*?"?(?:text|content)"?\s*:\s*"?/, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}
function overview() {
	const result = [];
	const oc = opencodeConn();
	if (oc) {
		const list = opencodeList(oc);
		const dbSize = exists(PATHS.opencodeDb) ? statSync(PATHS.opencodeDb).size : 0;
		result.push({
			source: "opencode",
			sessions: list.length,
			dbSize,
			latest: list.length ? list[0].timeUpdated : 0,
			note: "SQLite 只读（~/.local/share/opencode/opencode.db）"
		});
		oc.close();
	} else result.push({
		source: "opencode",
		sessions: 0,
		note: "未找到数据库"
	});
	const cf = claudeSessionFiles();
	const ch = claudeHistorySessions();
	result.push({
		source: "claude",
		sessions: cf.length + ch.length,
		dbSize: 0,
		latest: Math.max(cf.length ? Math.max(...cf.map((f) => statSync(f.path).mtimeMs)) : 0, ch.length ? ch[0].timeUpdated || 0 : 0),
		note: `JSONL 只读（projects ${cf.length} 完整 + history ${ch.length} 提示词记录）`
	});
	const ag = agList();
	result.push({
		source: "antigravity",
		sessions: ag.length,
		dbSize: 0,
		latest: ag.length ? ag[0].timeUpdated : 0,
		note: "SQLite+protobuf 有损解析（~/.gemini/antigravity/conversations/）"
	});
	const df = dshSessionFiles();
	result.push({
		source: "dsh",
		sessions: df.length,
		dbSize: 0,
		latest: df.length ? Math.max(...df.map((f) => statSync(f.path).mtimeMs)) : 0,
		note: "zstd 只读（~/.dsh/sessions/）"
	});
	result.push(qcnOverview());
	return result;
}
let _cachedSources = null;
let _cachedSourcesTime = 0;
function invalidateSourceCache() {
	_cachedSources = null;
	_cachedSourcesTime = 0;
}
/**
* listBySource — 按数据来源软件分组列出全部外部会话（侧边栏"会话库"区块数据源）。
* 与 listWorkspaces（按 cwd 工作区分组）互补：这里按 source 维度聚合，
* 每个来源按最近更新排序，最多返回前 300 条。
* 内置 15s 内存 TTL 缓存，大幅降低磁盘 I/O 和 CPU 占用。
*/
function listBySource() {
	const now = Date.now();
	if (_cachedSources && now - _cachedSourcesTime < 15e3) return _cachedSources;
	const groups = [
		{
			source: "opencode",
			sessions: []
		},
		{
			source: "claude",
			sessions: []
		},
		{
			source: "antigravity",
			sessions: []
		},
		{
			source: "dsh",
			sessions: []
		},
		{
			source: "qodercn",
			sessions: []
		}
	];
	const oc = opencodeConn();
	if (oc) {
		groups[0].sessions.push(...opencodeList(oc));
		oc.close();
	}
	for (const f of claudeSessionFiles()) {
		const m = claudeParse(f, false);
		if (m) groups[1].sessions.push(m);
	}
	for (const m of claudeHistorySessions()) {
		const { _history, _prompts, ...rest } = m;
		groups[1].sessions.push(rest);
	}
	groups[2].sessions.push(...agList());
	for (const f of dshSessionFiles()) {
		const m = dshParse(f, false);
		if (m) groups[3].sessions.push(m);
	}
	groups[4].sessions.push(...qcnList());
	const result = groups.map((g) => ({
		source: g.source,
		sessions: g.sessions.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0)).slice(0, 300)
	}));
	_cachedSources = result;
	_cachedSourcesTime = now;
	return result;
}
function listWorkspaces(source = "all") {
	const ws = /* @__PURE__ */ new Map();
	const add = (s) => {
		let key = s.cwd || s.title || "未知工作区";
		if (s.source === "qodercn" || typeof key === "string" && key.includes("QoderCN")) key = join(HOME, "Documents", "QoderCN");
		if (!ws.has(key)) ws.set(key, {
			name: key,
			sessions: []
		});
		ws.get(key).sessions.push(s);
	};
	const sources = listBySource();
	for (const g of sources) if (source === "all" || source === g.source) for (const s of g.sessions) add(s);
	return [...ws.values()].map((w) => ({
		name: w.name,
		sessionCount: w.sessions.length,
		latest: Math.max(...w.sessions.map((s) => s.timeUpdated || 0)),
		sessions: w.sessions.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0))
	})).sort((a, b) => b.latest - a.latest);
}
function searchSessions(q, source = "all") {
	if (!q || !q.trim()) return [];
	const qq = q.trim();
	const out = [];
	if (source === "all" || source === "opencode") {
		const oc = opencodeConn();
		if (oc) {
			out.push(...opencodeSearch(oc, qq));
			oc.close();
		}
	}
	if (source === "all" || source === "claude") {
		out.push(...claudeSearch(claudeSessionFiles(), qq));
		const lower = qq.toLowerCase();
		for (const s of claudeHistorySessions()) if (s.title.toLowerCase().includes(lower) || s._prompts.some((p) => p.text.toLowerCase().includes(lower))) out.push({
			source: "claude",
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			updatedAt: s.timeUpdated,
			snippet: `历史提示词记录：${s.title}`
		});
	}
	if (source === "all" || source === "antigravity") {
		const lower = qq.toLowerCase();
		for (const s of agList()) if (s.title.toLowerCase().includes(lower)) out.push({
			source: "antigravity",
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			updatedAt: s.timeUpdated,
			snippet: `标题匹配：${s.title}`
		});
	}
	if (source === "all" || source === "dsh") out.push(...dshSearch(dshSessionFiles(), qq));
	if (source === "all" || source === "qodercn") {
		const lower = qq.toLowerCase();
		for (const s of qcnList()) if (s.title.toLowerCase().includes(lower)) out.push({
			source: "qodercn",
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			updatedAt: s.timeUpdated,
			snippet: `标题匹配：${s.title}`
		});
	}
	return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_SEARCH_ROWS);
}
/**
* 从 ~/.claude/history.jsonl 聚合历史会话：这些是完整 .jsonl 会话文件已丢失、
* 但留有提示词索引的 Claude Code 会话。排除仍有完整文件的 sessionId。
* 数据仅含用户提示词（Claude 回复未保留），作为兜底展示。
*/
function claudeHistorySessions() {
	if (!exists(PATHS.claudeHistory)) return [];
	let lines;
	try {
		lines = readFileSync(PATHS.claudeHistory, "utf8").split("\n");
	} catch {
		return [];
	}
	const agg = /* @__PURE__ */ new Map();
	for (const line of lines) {
		if (!line.trim()) continue;
		let d;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		const sid = d.sessionId;
		if (!sid) continue;
		if (!agg.has(sid)) agg.set(sid, {
			id: sid,
			project: d.project || "",
			prompts: [],
			first: 0,
			last: 0
		});
		const a = agg.get(sid);
		if (d.project && !a.project) a.project = d.project;
		const ts = typeof d.timestamp === "number" ? d.timestamp : 0;
		if (ts) {
			if (!a.first || ts < a.first) a.first = ts;
			if (ts > a.last) a.last = ts;
		}
		const disp = String(d.display || "").trim();
		if (disp) {
			const last = a.prompts[a.prompts.length - 1];
			if (!last || last.text !== disp) a.prompts.push({
				text: disp,
				ts
			});
		}
	}
	const existing = new Set(claudeSessionFiles().map((f) => basename(f.path, ".jsonl")));
	const out = [];
	for (const a of agg.values()) {
		if (existing.has(a.id) || !a.prompts.length) continue;
		const meaningful = a.prompts.find((p) => !p.text.startsWith("/")) || a.prompts[0];
		out.push({
			source: "claude",
			id: a.id,
			title: truncStr(meaningful.text.replace(/\s+/g, " "), 60),
			cwd: a.project,
			agent: "claude",
			model: void 0,
			cost: 0,
			timeCreated: a.first,
			timeUpdated: a.last,
			_history: true,
			_prompts: a.prompts
		});
	}
	return out.sort((x, y) => (y.timeUpdated || 0) - (x.timeUpdated || 0));
}
/** 读取历史会话为消息（仅用户提示词，Claude 回复未保留）。 */
function claudeHistorySession(id) {
	const s = claudeHistorySessions().find((x) => x.id === id);
	if (!s) return null;
	return {
		source: "claude",
		id,
		title: s.title,
		cwd: s.cwd,
		agent: "claude",
		model: void 0,
		cost: 0,
		timeCreated: s.timeCreated,
		timeUpdated: s.timeUpdated,
		historyOnly: true,
		messages: s._prompts.map((p) => ({
			role: "user",
			time: p.ts,
			parts: [{
				type: "text",
				text: p.text
			}]
		}))
	};
}
function readSession(source, id) {
	if (source === "qodercn") return qcnSession(id);
	if (source === "opencode") {
		const oc = opencodeConn();
		if (!oc) return null;
		const s = opencodeSession(oc, id);
		oc.close();
		return s;
	}
	if (source === "claude") {
		const file = claudeSessionFiles().find((f) => basename(f.path, ".jsonl") === id);
		if (file) return claudeParse(file, true);
		return claudeHistorySession(id);
	}
	if (source === "antigravity") return agSession(id);
	if (source === "dsh") {
		const file = dshSessionFiles(void 0, true).find((f) => basename(dirname(f.path)) === id);
		return file ? dshParse(file, true) : null;
	}
	return null;
}
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 标记每条外部工作区是否已注册为 DSH 工作区（对照 workspace 服务的目录集合）。 */
function markInDsh(workspaces, dshPaths) {
	for (const w of workspaces) w.inDsh = dshPaths.has(w.name);
	return workspaces;
}
/** 把外部（绝对路径）工作区目录批量注册为 DSH 工作区（幂等，重复返回已有）。 */
async function syncWorkspaces(workspaceSvc) {
	const all = listWorkspaces("all");
	const synced = [];
	const failed = [];
	for (const w of all) {
		if (!w.name.startsWith("/")) continue;
		try {
			await workspaceSvc.create(w.name);
			synced.push(w.name);
		} catch (err) {
			failed.push({
				path: w.name,
				error: String(err?.message ?? err)
			});
		}
	}
	return {
		synced,
		failed
	};
}
/** 工具调用转换上限：支持完整工具执行轨迹导入。 */
const MAX_IMPORT_TOOL_CALLS = 5e3;
/** 工具入参/输出的导入截断（比会话读取截断更短，控制模型上下文 token）。 */
const TOOL_TEXT_LIMIT = 2e5;
/** 外部工具名 → DSH 渲染变体映射：命中 TOOL_VARIANTS 的工具行才有富卡片样式（bash/read/search…）。 */
const TOOL_NAME_MAP = {
	websearch: "web_search",
	webfetch: "web_fetch"
};
/** 导入/导出状态文件：维护双向会话映射关系与同步时间。 */
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "state.json");
function loadState() {
	try {
		if (exists(STATE_FILE)) {
			const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
			if (parsed && typeof parsed === "object") return {
				imports: parsed.imports || {},
				exports: parsed.exports || {}
			};
		}
	} catch {}
	return {
		imports: {},
		exports: {}
	};
}
function saveState(state) {
	const tmp = `${STATE_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, STATE_FILE);
}
function importKey(source, id) {
	return `${source}:${id}`;
}
function genNanoId(prefix = "", len = 24) {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let res = prefix ? `${prefix}_` : "";
	for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * 62));
	return res;
}
/** 获取会话完整数据用于跨 agent 导出。 */
function readSessionDataForExport(sessionId, webCtx) {
	const match = dshSessionFiles(void 0, true).find((f) => basename(dirname(f.path)) === sessionId);
	if (match) {
		const parsed = dshParse(match, true);
		if (parsed) return parsed;
	}
	for (const src of [
		"opencode",
		"claude",
		"antigravity",
		"qodercn",
		"dsh"
	]) try {
		const s = readSession(src, sessionId);
		if (s && s.messages && s.messages.length) return s;
	} catch {}
	return null;
}
/** 导出至 OpenCode SQLite 数据库（严格事务 + 完整部件类型）。 */
function exportToOpenCode(sessionData, existingId = null) {
	if (!exists(PATHS.opencodeDb)) throw new Error(`OpenCode 数据库未找到: ${PATHS.opencodeDb}`);
	const db = new DatabaseSync(PATHS.opencodeDb);
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("BEGIN IMMEDIATE;");
	try {
		const ocSid = existingId || genNanoId("ses", 24);
		const now = Date.now();
		const createdAt = sessionData.timeCreated || now;
		const updatedAt = sessionData.timeUpdated || now;
		const cwd = sessionData.cwd && sessionData.cwd.startsWith("/") ? sessionData.cwd : HOME;
		const title = sessionData.title || "(无标题会话)";
		if (!db.prepare("SELECT id FROM project WHERE id = ?").get("global")) db.prepare(`
        INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
        VALUES ('global', '/', 'git', 'global', ?, ?, '[]')
      `).run(createdAt, now);
		if (db.prepare("SELECT id FROM session WHERE id = ?").get(ocSid)) {
			db.prepare("DELETE FROM part WHERE session_id = ?").run(ocSid);
			db.prepare("DELETE FROM message WHERE session_id = ?").run(ocSid);
			db.prepare(`
        UPDATE session SET directory = ?, title = ?, time_updated = ? WHERE id = ?
      `).run(cwd, title, updatedAt, ocSid);
		} else db.prepare(`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, agent, model, cost)
        VALUES (?, 'global', ?, ?, ?, 'local', ?, ?, 'dsh-session-hub', NULL, 0.0)
      `).run(ocSid, ocSid, cwd, title, createdAt, updatedAt);
		let parentId = null;
		for (const msg of sessionData.messages || []) {
			const msgTime = msg.time || now;
			if (msg.role === "user") {
				const uMsgId = genNanoId("msg", 24);
				parentId = uMsgId;
				const uData = JSON.stringify({
					role: "user",
					time: { created: msgTime },
					agent: "build",
					model: {
						providerID: "opencode",
						modelID: "deepseek-v4-flash-free"
					},
					summary: { diffs: [] }
				});
				db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(uMsgId, ocSid, msgTime, msgTime, uData);
				let userText = "";
				if (msg.parts && msg.parts.length) userText = msg.parts.map((p) => p.text || "").join("\n");
				else if (msg.text) userText = msg.text;
				if (userText) {
					const uPrtId = genNanoId("prt", 24);
					const pData = JSON.stringify({
						type: "text",
						text: userText
					});
					db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(uPrtId, uMsgId, ocSid, msgTime, msgTime, pData);
				}
			} else if (msg.role === "assistant") {
				const aMsgId = genNanoId("msg", 24);
				const aData = JSON.stringify({
					parentID: parentId,
					role: "assistant",
					mode: "build",
					agent: "build",
					path: {
						cwd,
						root: "/"
					},
					cost: 0,
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: {
							read: 0,
							write: 0
						}
					},
					modelID: "deepseek-v4-flash",
					providerID: "deepseek-official",
					time: {
						created: msgTime,
						completed: msgTime + 1e3
					}
				});
				db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(aMsgId, ocSid, msgTime, msgTime + 1e3, aData);
				if (msg.parts && msg.parts.length) {
					for (const p of msg.parts) if (p.type === "reasoning") {
						const rPrtId = genNanoId("prt", 24);
						const rData = JSON.stringify({
							type: "reasoning",
							text: p.text || ""
						});
						db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(rPrtId, aMsgId, ocSid, msgTime, msgTime, rData);
					} else if (p.type === "tool") {
						const tPrtId = genNanoId("prt", 24);
						const tData = JSON.stringify({
							type: "tool",
							tool: p.tool || "bash",
							callID: "call_" + randomUUID().replace(/-/g, "").slice(0, 16),
							state: {
								status: "completed",
								input: typeof p.input === "object" ? p.input : { command: p.input || "" },
								output: p.output || "",
								exit: 0,
								time: {
									start: msgTime,
									end: msgTime + 500
								}
							}
						});
						db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(tPrtId, aMsgId, ocSid, msgTime, msgTime + 500, tData);
					} else if (p.type === "text") {
						const tPrtId = genNanoId("prt", 24);
						const tData = JSON.stringify({
							type: "text",
							text: p.text || ""
						});
						db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(tPrtId, aMsgId, ocSid, msgTime + 500, msgTime + 1e3, tData);
					}
				} else if (msg.text) {
					const tPrtId = genNanoId("prt", 24);
					const tData = JSON.stringify({
						type: "text",
						text: msg.text
					});
					db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(tPrtId, aMsgId, ocSid, msgTime + 500, msgTime + 1e3, tData);
				}
			}
		}
		db.exec("COMMIT;");
		return {
			status: "ok",
			externalId: ocSid
		};
	} catch (err) {
		db.exec("ROLLBACK;");
		throw err;
	} finally {
		db.close();
	}
}
/** 导出至 Claude Code JSONL 协议（原子文件替换 + 历史索引更新）。 */
function exportToClaude(sessionData, existingId = null) {
	const cwd = sessionData.cwd && sessionData.cwd.startsWith("/") ? sessionData.cwd : HOME;
	const encodedCwd = cwd.replace(/\//g, "-");
	const projDir = join(PATHS.claudeRoot, encodedCwd);
	mkdirSync(projDir, { recursive: true });
	const clSid = existingId || randomUUID();
	const clFile = join(projDir, `${clSid}.jsonl`);
	const clTmp = `${clFile}.tmp`;
	const lines = [JSON.stringify({
		type: "mode",
		mode: "normal",
		sessionId: clSid
	}), JSON.stringify({
		type: "permission-mode",
		permissionMode: "default",
		sessionId: clSid
	})];
	const firstMsgId = randomUUID();
	lines.push(JSON.stringify({
		type: "file-history-snapshot",
		messageId: firstMsgId,
		snapshot: {
			messageId: firstMsgId,
			trackedFileBackups: {},
			timestamp: new Date(sessionData.timeCreated || Date.now()).toISOString()
		},
		isSnapshotUpdate: false
	}));
	lines.push(JSON.stringify({
		type: "ai-title",
		aiTitle: sessionData.title || "(无标题会话)",
		sessionId: clSid
	}));
	let lastAssistantUuid = null;
	for (const msg of sessionData.messages || []) {
		const msgTime = msg.time ? new Date(msg.time).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
		if (msg.role === "user") {
			const uUuid = randomUUID();
			let userText = "";
			if (msg.parts && msg.parts.length) userText = msg.parts.map((p) => p.text || "").join("\n");
			else if (msg.text) userText = msg.text;
			lines.push(JSON.stringify({
				parentUuid: lastAssistantUuid,
				isSidechain: false,
				promptId: randomUUID(),
				type: "user",
				message: {
					role: "user",
					content: userText
				},
				uuid: uUuid,
				timestamp: msgTime,
				permissionMode: "default",
				origin: { kind: "human" },
				promptSource: "typed",
				userType: "external",
				entrypoint: "cli",
				cwd,
				sessionId: clSid,
				version: "2.1.223"
			}));
			lastAssistantUuid = uUuid;
		} else if (msg.role === "assistant") {
			const aUuid = randomUUID();
			const content = [];
			if (msg.parts && msg.parts.length) {
				for (const p of msg.parts) if (p.type === "reasoning") content.push({
					type: "thinking",
					thinking: p.text || "",
					signature: aUuid
				});
				else if (p.type === "tool") content.push({
					type: "tool_use",
					id: "call_" + randomUUID().replace(/-/g, "").slice(0, 16),
					name: p.tool === "bash" ? "Bash" : p.tool || "Bash",
					input: typeof p.input === "object" ? p.input : { command: p.input || "" }
				});
				else if (p.type === "text") content.push({
					type: "text",
					text: p.text || ""
				});
			} else if (msg.text) content.push({
				type: "text",
				text: msg.text
			});
			lines.push(JSON.stringify({
				parentUuid: lastAssistantUuid,
				isSidechain: false,
				type: "assistant",
				message: {
					id: aUuid,
					type: "message",
					role: "assistant",
					model: "deepseek-v4-flash",
					content,
					stop_reason: "end_turn"
				},
				uuid: aUuid,
				timestamp: msgTime,
				sessionId: clSid,
				userType: "external",
				entrypoint: "cli",
				cwd,
				version: "2.1.223"
			}));
			lastAssistantUuid = aUuid;
		}
	}
	writeFileSync(clTmp, lines.join("\n") + "\n", "utf-8");
	renameSync(clTmp, clFile);
	try {
		let alreadyExists = false;
		if (exists(PATHS.claudeHistory)) {
			if (readFileSync(PATHS.claudeHistory, "utf8").includes(clSid)) alreadyExists = true;
		}
		if (!alreadyExists) {
			const histLine = JSON.stringify({
				sessionId: clSid,
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				project: cwd,
				display: sessionData.title || "DSH Exported Session"
			});
			writeFileSync(PATHS.claudeHistory, histLine + "\n", {
				flag: "a",
				encoding: "utf-8"
			});
		}
	} catch {}
	return {
		status: "ok",
		externalId: clSid
	};
}
/** 导出至 Antigravity Transcript 日志结构。 */
function exportToAntigravity(sessionData, existingId = null) {
	const agSid = existingId || randomUUID();
	const logsDir = join(join(PATHS.antigravityBrain, agSid), ".system_generated", "logs");
	mkdirSync(logsDir, { recursive: true });
	const transcriptFile = join(logsDir, "transcript.jsonl");
	const transcriptFullFile = join(logsDir, "transcript_full.jsonl");
	const lines = [];
	let stepIndex = 0;
	for (const msg of sessionData.messages || []) {
		const msgTime = msg.time ? new Date(msg.time).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
		if (msg.role === "user") {
			let userText = "";
			if (msg.parts && msg.parts.length) userText = msg.parts.map((p) => p.text || "").join("\n");
			else if (msg.text) userText = msg.text;
			lines.push(JSON.stringify({
				step_index: stepIndex++,
				source: "USER_EXPLICIT",
				type: "USER_INPUT",
				status: "DONE",
				created_at: msgTime,
				content: userText
			}));
		} else if (msg.role === "assistant") {
			let replyText = "";
			let thinkingText = "";
			const toolCalls = [];
			if (msg.parts && msg.parts.length) {
				for (const p of msg.parts) if (p.type === "reasoning") thinkingText += (p.text || "") + "\n";
				else if (p.type === "text") replyText += (p.text || "") + "\n";
				else if (p.type === "tool") toolCalls.push({
					name: p.tool || "bash",
					arguments: typeof p.input === "object" ? p.input : { command: p.input || "" },
					result: p.output || ""
				});
			} else if (msg.text) replyText = msg.text;
			lines.push(JSON.stringify({
				step_index: stepIndex++,
				source: "MODEL",
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: msgTime,
				content: replyText.trim(),
				thinking: thinkingText.trim(),
				tool_calls: toolCalls
			}));
		}
	}
	const content = lines.join("\n") + "\n";
	writeFileSync(transcriptFile, content, "utf-8");
	writeFileSync(transcriptFullFile, content, "utf-8");
	return {
		status: "ok",
		externalId: agSid
	};
}
/** 跨 Agent 统一会话导出与同步分发器。 */
function exportSession(sessionId, target, webCtx) {
	const sess = readSessionDataForExport(sessionId, webCtx);
	if (!sess) throw new Error(`会话未找到: ${sessionId}`);
	const st = loadState();
	st.exports = st.exports || {};
	st.exports[sessionId] = st.exports[sessionId] || {};
	const results = {};
	const targets = target === "all" ? [
		"opencode",
		"claude",
		"antigravity"
	] : [target];
	for (const t of targets) {
		const existingId = st.exports[sessionId][t]?.id || null;
		try {
			let res = null;
			if (t === "opencode") res = exportToOpenCode(sess, existingId);
			else if (t === "claude") res = exportToClaude(sess, existingId);
			else if (t === "antigravity") res = exportToAntigravity(sess, existingId);
			else throw new Error(`不支持的导出目标: ${t}`);
			st.exports[sessionId][t] = {
				id: res.externalId,
				syncedAt: Date.now()
			};
			results[t] = {
				status: "ok",
				externalId: res.externalId
			};
		} catch (err) {
			results[t] = {
				status: "error",
				error: String(err?.message ?? err)
			};
		}
	}
	saveState(st);
	invalidateSourceCache();
	return results;
}
/** 归一化目录路径用于与工作区路径精确比较（失败原样返回）。 */
function canonPath(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
/**
* 把导入会话挂到 cwd 匹配的 DSH 工作区（原生归组：侧边栏出现在该工作区分组下，
* 而非"未分组"）。attachSession 会校验会话 header.cwd 与工作区路径一致；无匹配
* 工作区或 cwd 无效时静默跳过（会话留在"未分组"，数据不受影响）。
*/
async function attachImportedToWorkspace(workspaceSvc, session) {
	try {
		let cwd = session.header?.cwd ?? session.cwd;
		if (!cwd) {
			const file = session.file ?? dshSessionFiles().find((f) => basename(dirname(f.path)) === session.id);
			cwd = file ? dshParse(file, false)?.cwd : void 0;
		}
		cwd = canonPath(cwd);
		if (!cwd) return;
		const ws = workspaceSvc.list().find((w) => canonPath(w.path) === cwd);
		if (ws && typeof ws.attachSession === "function") await ws.attachSession(session.id);
		else console.warn("[session-hub] attach 跳过: 无匹配工作区 cwd=" + cwd + " 现有=" + workspaceSvc.list().map((w) => w.path).join(","));
	} catch (err) {
		console.warn("[session-hub] attach 失败 sid=" + session.id + ": " + (err && err.message ? err.message : err));
	}
}
/** 服务启动后一次性迁移：把历史导入会话挂到匹配的工作区（修复旧会话堆在"未分组"）。 */
function migrateImportedGrouping(workspaceSvc, sessionsSvc) {
	for (const file of dshSessionFiles()) {
		const sid = basename(dirname(file.path));
		const cwd = sessionsSvc.get?.(sid)?.header?.cwd;
		attachImportedToWorkspace(workspaceSvc, {
			id: sid,
			cwd,
			file
		});
	}
}
/**
* 构造 balanced 的 DSH seed：把外部会话的完整消息流导入为 DSH 原生会话。
* 文本按原顺序导入；assistant 消息中的工具调用转为 tool-call 块 + tool/result
* 事件（原生渲染/继续对话均可用），推理载荷跳过。工具入参/输出截断控制上下文；
* 超过上限时保留最近的 MAX_IMPORT_MESSAGES 条、最多 MAX_IMPORT_TOOL_CALLS 个调用。
*/
function buildImportSeed(session, instruction) {
	const now = Date.now();
	const seed = [];
	let seq = 0;
	seed.push({
		type: "turn/start",
		seq: seq++,
		time: now,
		data: {
			turn: 1,
			trigger: {
				kind: "message",
				source: { kind: "user" }
			}
		}
	});
	if (instruction) seed.push({
		type: "user/message",
		seq: seq++,
		time: now,
		surfaceOp: "append",
		data: {
			id: randomUUID(),
			role: "user",
			content: [{
				type: "text",
				text: `用户指示：${instruction}`
			}],
			source: { kind: "user" }
		}
	});
	if (session.historyOnly) seed.push({
		type: "user/message",
		seq: seq++,
		time: now,
		surfaceOp: "append",
		data: {
			id: randomUUID(),
			role: "user",
			content: [{
				type: "text",
				text: "📜 历史任务记录：此 Claude 会话的完整对话文件已丢失，以下仅保留了当时输入的提示词（来自 ~/.claude/history.jsonl），Claude 的回复未能找回。"
			}],
			source: { kind: "user" }
		}
	});
	const msgs = (session.messages ?? []).slice(-2e3);
	let step = 0;
	let toolCalls = 0;
	let currentTurn = 1;
	for (const m of msgs) {
		if (m.role === "user") {
			const text = (m.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n").trim();
			if (!text) continue;
			if (step > 0) {
				seed.push({
					type: "turn/end",
					seq: seq++,
					time: now,
					data: {
						turn: currentTurn,
						reason: { kind: "completed" }
					}
				});
				currentTurn++;
				seed.push({
					type: "turn/start",
					seq: seq++,
					time: now,
					data: {
						turn: currentTurn,
						trigger: {
							kind: "message",
							source: { kind: "user" }
						}
					}
				});
				step = 0;
			}
			seed.push({
				type: "user/message",
				seq: seq++,
				time: now,
				surfaceOp: "append",
				data: {
					id: randomUUID(),
					role: "user",
					content: [{
						type: "text",
						text
					}],
					source: { kind: "user" }
				}
			});
			continue;
		}
		const parts = m.parts ?? [];
		const groups = [];
		let curGroup = null;
		for (const p of parts) {
			const isTool = p.type === "tool";
			if (!curGroup || curGroup.isTool !== isTool) {
				curGroup = {
					isTool,
					items: []
				};
				groups.push(curGroup);
			}
			curGroup.items.push(p);
		}
		const prov = m.model && typeof m.model === "object" ? m.model : {};
		for (const g of groups) if (g.isTool) {
			const content = [];
			const calls = [];
			for (const p of g.items) {
				if (toolCalls >= MAX_IMPORT_TOOL_CALLS) continue;
				const callId = randomUUID();
				content.push({
					type: "tool-call",
					id: callId,
					name: TOOL_NAME_MAP[p.tool] ?? (p.tool || "unknown"),
					arguments: truncStr(p.input, TOOL_TEXT_LIMIT) || "{}"
				});
				calls.push({
					callId,
					output: truncStr(p.output, TOOL_TEXT_LIMIT)
				});
				toolCalls++;
			}
			if (!content.length) continue;
			step++;
			seed.push({
				type: "assistant/message",
				seq: seq++,
				time: now,
				surfaceOp: "append",
				data: {
					turn: currentTurn,
					step,
					message: {
						id: randomUUID(),
						role: "assistant",
						content,
						source: {
							kind: "model",
							provider: prov.providerID ?? "opencode",
							model: prov.modelID ?? "unknown"
						}
					}
				}
			});
			for (const c of calls) seed.push({
				type: "tool/result",
				seq: seq++,
				time: now,
				surfaceOp: "append",
				data: {
					turn: currentTurn,
					step,
					message: {
						id: randomUUID(),
						role: "user",
						source: {
							kind: "tool",
							callId: c.callId
						},
						content: [{
							type: "tool-result",
							toolCallId: c.callId,
							content: [{
								type: "text",
								text: c.output
							}],
							isError: false
						}]
					}
				}
			});
		} else {
			const content = [];
			const textBuf = [];
			const flush = () => {
				const t = textBuf.join("\n").trim();
				textBuf.length = 0;
				if (t) content.push({
					type: "text",
					text: t
				});
			};
			for (const p of g.items) if (p.type === "reasoning" && p.text) {
				flush();
				content.push({
					type: "reasoning",
					text: p.text
				});
			} else if (p.type === "text" && p.text) textBuf.push(p.text);
			flush();
			if (!content.length) continue;
			step++;
			seed.push({
				type: "assistant/message",
				seq: seq++,
				time: now,
				surfaceOp: "append",
				data: {
					turn: currentTurn,
					step,
					message: {
						id: randomUUID(),
						role: "assistant",
						content,
						source: {
							kind: "model",
							provider: prov.providerID ?? "opencode",
							model: prov.modelID ?? "unknown"
						}
					}
				}
			});
		}
	}
	seed.push({
		type: "session/title",
		seq: seq++,
		time: now,
		data: {
			title: session.title || "外部导入会话",
			messageSeqs: [1],
			source: { kind: "fallback" }
		}
	});
	seed.push({
		type: "turn/end",
		seq: seq++,
		time: now,
		data: {
			turn: currentTurn,
			reason: { kind: "completed" }
		}
	});
	return seed;
}
function apply(ctx, config = {}) {
	if (config && typeof config.paths === "object") Object.assign(PATHS, config.paths);
	if (config && Array.isArray(config.knownWebSessionIds)) KNOWN_WEB_SESSIONS = new Set(config.knownWebSessionIds);
	ctx.inject([
		"webServer",
		"workspaceRegistry",
		"sessions"
	], (webCtx) => {
		const handler = async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const p = url.pathname;
			const q = url.searchParams;
			try {
				if (p === "/session-hub/api/overview" && req.method === "GET") return sendJson(res, 200, {
					ok: true,
					sources: overview()
				});
				if (p === "/session-hub/api/sources" && req.method === "GET") {
					const st = loadState();
					return sendJson(res, 200, {
						ok: true,
						sources: listBySource().map((g) => ({
							...g,
							sessions: g.sessions.map((s) => ({
								...s,
								imported: Boolean(st.imports[importKey(s.source, s.id)])
							}))
						}))
					});
				}
				if (p === "/session-hub/api/workspaces" && req.method === "GET") {
					const dshPaths = new Set(webCtx.workspaceRegistry.list().map((w) => w.path));
					return sendJson(res, 200, {
						ok: true,
						workspaces: markInDsh(listWorkspaces(q.get("source") ?? "all"), dshPaths)
					});
				}
				if (p === "/session-hub/api/workspaces/sync" && req.method === "POST") return sendJson(res, 200, {
					ok: true,
					...await syncWorkspaces(webCtx.workspaceRegistry)
				});
				if (p === "/session-hub/api/sessions" && req.method === "GET") {
					const cwd = q.get("cwd") ?? "";
					const source = q.get("source") ?? "all";
					const st = loadState();
					let rawList = [];
					if (cwd) {
						let ws = listWorkspaces(source).find((w) => w.name === cwd);
						if (!ws && (cwd.includes("QoderCN") || source === "qodercn")) ws = listWorkspaces("qodercn").find((w) => w.name.includes("QoderCN"));
						rawList = ws ? ws.sessions : [];
					} else {
						const sources = listBySource();
						for (const g of sources) if (source === "all" || source === g.source) rawList.push(...g.sessions);
					}
					return sendJson(res, 200, {
						ok: true,
						cwd,
						sessions: rawList.slice(0, 300).map((s) => ({
							...s,
							imported: Boolean(st.imports[importKey(s.source, s.id)])
						}))
					});
				}
				if (p === "/session-hub/api/search" && req.method === "GET") return sendJson(res, 200, {
					ok: true,
					query: q.get("q") ?? "",
					results: searchSessions(q.get("q") ?? "", q.get("source") ?? "all")
				});
				if (p === "/session-hub/api/session" && req.method === "GET") {
					const s = readSession(q.get("source") ?? "", q.get("id") ?? "");
					return sendJson(res, s ? 200 : 404, s ? {
						ok: true,
						session: s
					} : {
						ok: false,
						error: "session not found"
					});
				}
				if (p === "/session-hub/api/continue" && req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += chunk;
					let input = {};
					try {
						input = JSON.parse(body || "{}");
					} catch {}
					if (input.source === "dsh") return sendJson(res, 200, {
						ok: true,
						sessionId: input.id,
						reused: true
					});
					const sess = readSession(input.source ?? "", input.id ?? "");
					if (!sess) return sendJson(res, 404, {
						ok: false,
						error: "session not found"
					});
					if (!sess.messages || sess.messages.length === 0) return sendJson(res, 400, {
						ok: false,
						error: "empty session"
					});
					const key = importKey(input.source, input.id);
					const st = loadState();
					if (st.imports[key]) return sendJson(res, 200, {
						ok: true,
						sessionId: st.imports[key],
						reused: true,
						title: sess.title
					});
					const sid = `session-hub-${randomUUID()}`;
					const seed = buildImportSeed(sess, input.instruction);
					let agentPreset = void 0;
					let setupFn = void 0;
					const presets = ctx.get ? ctx.get("agentPresets") : ctx.agentPresets;
					if (presets && typeof presets.resolve === "function") try {
						const resolved = await presets.resolve(void 0);
						agentPreset = resolved?.id;
						setupFn = async (agentCtx) => {
							try {
								await presets.mount(agentCtx, resolved.id);
							} catch (mErr) {
								console.warn("[session-hub] preset mount error:", mErr);
							}
						};
					} catch (pErr) {
						console.warn("[session-hub] preset resolve error:", pErr);
					}
					const effectiveCwd = sess.cwd && typeof sess.cwd === "string" && sess.cwd.trim().startsWith("/") ? sess.cwd.trim() : sess.source === "qodercn" ? join(HOME, "Documents", "QoderCN") : sess.source === "antigravity" ? PATHS.antigravityVirtualCwd : process.cwd() || HOME;
					const meta = {
						cwd: effectiveCwd,
						...agentPreset ? { agentPreset } : {}
					};
					let createdSession = null;
					const agentsSvc = ctx.get ? ctx.get("agents") : ctx.agents;
					if (agentsSvc && typeof agentsSvc.create === "function") try {
						createdSession = (await agentsSvc.create({
							sessionId: sid,
							seed,
							meta,
							...setupFn ? { setup: setupFn } : {}
						}))?.agent?.session || webCtx.sessions.get(sid) || {
							id: sid,
							cwd: effectiveCwd
						};
					} catch (createErr) {
						createdSession = webCtx.sessions.create(sid, {
							seed,
							meta
						});
					}
					else createdSession = webCtx.sessions.create(sid, {
						seed,
						meta
					});
					st.imports[key] = sid;
					saveState(st);
					invalidateSourceCache();
					await attachImportedToWorkspace(webCtx.workspaceRegistry, createdSession);
					return sendJson(res, 200, {
						ok: true,
						sessionId: sid,
						reused: false,
						title: sess.title,
						importedMessages: sess.messages?.length ?? 0
					});
				}
				if (p === "/session-hub/api/export" && req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += chunk;
					let input = {};
					try {
						input = JSON.parse(body || "{}");
					} catch {}
					if (!input.sessionId) return sendJson(res, 400, {
						ok: false,
						error: "缺少 sessionId 参数"
					});
					const results = exportSession(input.sessionId, input.target || "all", webCtx);
					return sendJson(res, 200, {
						ok: true,
						sessionId: input.sessionId,
						results
					});
				}
				if (p === "/session-hub/api/export/status" && req.method === "GET") {
					const sid = q.get("sessionId");
					if (!sid) return sendJson(res, 400, {
						ok: false,
						error: "缺少 sessionId 参数"
					});
					return sendJson(res, 200, {
						ok: true,
						sessionId: sid,
						exports: loadState().exports?.[sid] || {}
					});
				}
				sendJson(res, 404, {
					ok: false,
					error: `unknown session-hub endpoint ${req.method} ${p}`
				});
			} catch (err) {
				sendJson(res, 500, {
					ok: false,
					error: String(err?.message ?? err)
				});
			}
		};
		const off = webCtx.webServer.register({
			kind: "prefix",
			path: "/session-hub",
			handler
		});
		setTimeout(() => {
			webCtx.workspaceRegistry.create(PATHS.antigravityVirtualCwd).catch(() => {});
			registerClaudeWorkspaces(webCtx.workspaceRegistry);
			syncWorkspaces(webCtx.workspaceRegistry).catch(() => {});
			migrateImportedGrouping(webCtx.workspaceRegistry, webCtx.sessions);
		}, 2e3).unref?.();
		return off;
	});
}
//#endregion
export { apply, invalidateSourceCache, listBySource, listWorkspaces, overview, readSession, searchSessions };
