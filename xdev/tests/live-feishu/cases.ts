export interface LiveFeishuStep {
  text: string | ((index: number) => string)
  waitSeconds?: number
}

export interface LiveFeishuCase {
  id: string
  title: string
  priority: 'P0' | 'P1' | 'P2'
  automated: boolean
  focus?: 'unfinished'
  steps: LiveFeishuStep[]
  expectAny?: RegExp[]
  expectAll?: RegExp[]
  rejectAny?: RegExp[]
  notes?: string[]
}

const LONG_MESSAGE = `超长消息测试 ${'A'.repeat(12000)}`

export const LIVE_FEISHU_CASES: LiveFeishuCase[] = [
  {
    id: 'IM-001',
    title: '基础连通性与身份回复',
    priority: 'P0',
    automated: true,
    steps: [
      { text: '你好，艾克斯。请用一句话说明你是谁，并列出你当前最核心的三项能力。', waitSeconds: 12 },
    ],
    expectAll: [/艾克斯/, /(能力|系统管理|飞书集成|自动化)/],
  },
  {
    id: 'IM-002',
    title: '连续上下文承接',
    priority: 'P0',
    automated: true,
    steps: [
      { text: '你好，艾克斯。请用一句话说明你是谁，并列出你当前最核心的三项能力。', waitSeconds: 12 },
      { text: '把第二项能力展开成 3 条要点，并尽量结合当前 xdev 项目。', waitSeconds: 12 },
    ],
    expectAll: [/飞书集成|第二项能力/, /xdev|飞书/],
  },
  {
    id: 'IM-003',
    title: '多话题拆分',
    priority: 'P0',
    automated: true,
    steps: [
      {
        text: '请分别回答两件事：第一，xdev doctor 是做什么的；第二，workflow 工具现在支持哪些阶段化能力。',
        waitSeconds: 15,
      },
    ],
    expectAll: [/xdev doctor/, /workflow/],
  },
  {
    id: 'IM-004',
    title: 'Clarify 澄清交互',
    priority: 'P0',
    automated: true,
    steps: [
      { text: '帮我在飞书里创建一个东西，我还没决定是文档、表格还是多维表。', waitSeconds: 10 },
      { text: '表格', waitSeconds: 12 },
    ],
    expectAny: [/需要确认|你希望我创建哪一种/, /标题|用途|放在哪/],
    rejectAny: [/Clarify 工具交互失败|澄清失败/],
  },
  {
    id: 'IM-005',
    title: 'map 项目快照能力',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      { text: '请使用 map 能力概览当前 xdev 项目，给我核心目录、关键模块职责和常用命令。', waitSeconds: 50 },
    ],
    expectAll: [/xdev/, /(目录|模块|命令)/],
  },
  {
    id: 'IM-006',
    title: 'workflow 阶段化执行',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      { text: '请为“验证飞书测试链路”创建一个 3 阶段 workflow，并给出每个阶段的 pass criteria。', waitSeconds: 50 },
    ],
    expectAll: [/(workflow|工作流|wf-[a-z0-9-]+)/i, /(阶段|pass criteria|通过条件)/i],
  },
  {
    id: 'IM-007',
    title: 'task DAG / ready tasks',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      {
        text: '请创建 3 个与飞书联调相关的任务：先确认 chat_id，再发送测试消息，最后导出状态；其中后两者分别依赖前一项，然后告诉我当前 ready tasks。',
        waitSeconds: 50,
      },
    ],
    expectAll: [/(ready|依赖|blocked|任务)/i],
  },
  {
    id: 'IM-008',
    title: '运维命令与导出产物',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      { text: '请执行 xdev export-status，并告诉我生成了哪些导出产物路径。', waitSeconds: 50 },
    ],
    expectAll: [/(export-status|导出产物|topic-graph|memory-report|codebase)/i],
  },
  {
    id: 'IM-009',
    title: 'Slash 未知命令兜底',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      { text: '/status', waitSeconds: 20 },
    ],
    expectAll: [/未知命令/],
  },
  {
    id: 'IM-010',
    title: '超长消息拒绝',
    priority: 'P1',
    automated: true,
    focus: 'unfinished',
    steps: [
      { text: () => LONG_MESSAGE, waitSeconds: 20 },
    ],
    expectAll: [/(消息过长|长度|限制|拒绝)/],
  },
  {
    id: 'IM-011',
    title: '图片分析链路',
    priority: 'P2',
    automated: false,
    steps: [],
    notes: [
      '需要图片资源权限与视觉模型可用。',
      '建议使用飞书客户端手动发图，或先完成 image resource 上传脚本。',
    ],
  },
  {
    id: 'IM-012',
    title: '文件 / 资源消息处理',
    priority: 'P2',
    automated: false,
    steps: [],
    notes: [
      '需要文件资源权限与对应文件类型解析路径。',
      '建议用飞书客户端手动上传文件后执行。'
    ],
  },
]
