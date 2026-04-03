// src/agent/index.ts
// Agent 模块导出

export {
  MessageType,
  AgentMessage,
  MessageHandler,
  MessageBus,
  getMessageBus,
  resetMessageBus,
} from './message-bus';

export {
  AgentType,
  AgentConfig,
  AgentStatus,
  InProcessAgent,
} from './in-process-agent';

export {
  TeamMemberConfig,
  TeamConfig,
  TeamState,
  TaskRecord,
  TeamManager,
  createTeam,
  getTeam,
  listActiveTeams,
  shutdownAllTeams,
} from './team-manager';

// s10 Team Protocols
export {
  ProtocolType,
  ProtocolState,
  ProtocolRequest,
  ProtocolResponse,
  ProtocolHandler,
  TeamProtocols,
  TeamProtocolsConfig,
  getTeamProtocols,
  resetTeamProtocols,
  createShutdownHandler,
  createPlanApprovalHandler,
} from './team-protocols';

// s11 Autonomous Agents
export {
  AutonomousAgentConfig,
  AutonomousAgent,
  AutonomousAgentManager,
  getAutonomousAgentManager,
  resetAutonomousAgentManager,
} from './autonomous-agent';

// 重新导出 MessageType 枚举值
export { MessageType as MessageTypeEnum } from './message-bus';
