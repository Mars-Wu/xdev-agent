import type { Tool } from '../tool-interface'
import { createLarkAuthStatusTool } from './auth-tool'
import {
  createLarkCalendarAgendaTool,
  createLarkCalendarCreateTool,
  createLarkCalendarFreebusyTool,
} from './calendar-tool'
import { createLarkContactSearchUserTool } from './contact-tool'
import {
  createLarkDocsCreateTool,
  createLarkDocsFetchTool,
  createLarkDocsSearchTool,
  createLarkDocsUpdateTool,
} from './docs-tool'
import { createLarkImSearchMessagesTool, createLarkImSendTool } from './im-tool'

export { createLarkAuthStatusTool } from './auth-tool'
export {
  createLarkCalendarAgendaTool,
  createLarkCalendarCreateTool,
  createLarkCalendarFreebusyTool,
} from './calendar-tool'
export { createLarkContactSearchUserTool } from './contact-tool'
export {
  createLarkDocsCreateTool,
  createLarkDocsFetchTool,
  createLarkDocsSearchTool,
  createLarkDocsUpdateTool,
} from './docs-tool'
export { createLarkImSearchMessagesTool, createLarkImSendTool } from './im-tool'
export {
  appendBooleanFlag,
  appendNumberFlag,
  appendStringFlag,
  asRecordArray,
  isRecord,
  readBoolean,
  readNumber,
  readString,
  runLarkCli,
} from './runner'

export function createLarkTools(): Tool[] {
  return [
    createLarkAuthStatusTool(),
    createLarkContactSearchUserTool(),
    createLarkImSendTool(),
    createLarkImSearchMessagesTool(),
    createLarkDocsSearchTool(),
    createLarkDocsFetchTool(),
    createLarkDocsCreateTool(),
    createLarkDocsUpdateTool(),
    createLarkCalendarAgendaTool(),
    createLarkCalendarFreebusyTool(),
    createLarkCalendarCreateTool(),
  ]
}
