/* 共享 GLM 调用库（以 _ 开头不会被部署为独立函数）
   ------------------------------------------------------------
   模型：智谱 glm-4-flash（免费）
   两种审核模式：
     publish —— 发帖/笔记/聊天/发布前的实时过审（api-moderate 用）
     report  —— 用户举报后对被举报内容的 AI 初判（api-report 用）
   只输出 JSON，两处调用方各自解析。
*/
export const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const MODEL = "glm-4-flash";

const RULES = `违规判定标准：
1. 色情低俗、性暗示内容
2. 涉政敏感、危害国家安全或社会稳定的内容
3. 暴力血腥、恐吓威胁、教唆自残
4. 赌博、毒品、枪支等违禁品相关
5. 诈骗、钓鱼、刷单、传销、代考代写
6. 恶意广告、与社区无关的营销引流
7. 侮辱谩骂、人身攻击、地域或群体歧视
8. 泄露他人隐私（手机号、住址、身份证、密码等）
9. 木马病毒、盗版破解、外挂作弊
10. 未成年人相关的不良内容

以下内容一律视为正常，不要误判：
- 技术讨论、代码、报错求助、开源项目介绍
- 日常交流、开玩笑（无人身攻击）、表情
- 站点功能反馈、bug 报告`;

const PUBLISH_PROMPT = `你是 "BlueprintStudio" 程序员社区的内容审核员。判断提交的内容是否违规。

${RULES}

只输出 JSON，禁止输出其他任何文字：
{"clean": true或false, "category": "违规类别英文标识，正常则留空", "reason": "给用户看的简短中文说明，正常时填：内容正常"}`;

const REPORT_PROMPT = `你是 "BlueprintStudio" 程序员社区的举报审核员。用户举报了一段内容，请结合举报理由判断被举报内容本身是否违规。

${RULES}

注意：
- 你判断的是"被举报内容"是否真的违规，举报理由本身可能恶意或夸张，仅供参考
- 理由与内容对不上、或内容其实正常时，应判不违规

只输出 JSON，禁止输出其他任何文字：
{"violates": true或false, "category": "违规类别英文标识，不违规则留空", "reason": "给管理员看的中文分析，说明为什么违规/不违规"}`;

function clamp(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }

export async function judge(apiKey, mode, text, reportReason) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const userMsg = mode === "report"
      ? "举报理由：\n" + clamp(reportReason, 500) + "\n\n被举报内容：\n" + clamp(text, 6000)
      : "待审核内容：\n" + clamp(text, 6000);
    const r = await fetch(GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: mode === "report" ? REPORT_PROMPT : PUBLISH_PROMPT },
          { role: "user", content: userMsg },
        ],
        temperature: 0.05,
        max_tokens: 300,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("GLM HTTP " + r.status);
    const data = await r.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || "";
    /* 模型偶尔会包一层 ```json 围栏，剥掉再解析 */
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("GLM 返回无法解析");
    const v = JSON.parse(m[0]);
    if (mode === "report") {
      return {
        violates: v.violates === true,
        category: clamp(v.category || "", 40),
        reason: clamp(v.reason || "", 200),
      };
    }
    return {
      clean: v.clean !== false,
      category: clamp(v.category || "", 40),
      reason: clamp(v.reason || "", 120),
    };
  } finally {
    clearTimeout(timer);
  }
}
