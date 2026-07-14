import { z } from 'zod'

import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import { ToolDomainError } from '../tool-errors'
import {
  ANYSEARCH_DOMAINS,
  callAnySearch,
  type AnySearchClientContext,
} from './anysearch-client'

export const anySearchDomainsSchema = z.object({
  domains: z.array(z.enum(ANYSEARCH_DOMAINS)).min(1).max(5)
    .describe('要查询能力的 AnySearch 领域，1~5 个；垂直搜索前先查询相关领域'),
})

export type AnySearchDomainsArgs = z.infer<typeof anySearchDomainsSchema>

export interface AnySearchDomainsResult {
  source: 'anysearch'
  domains: string[]
  content: string
}
export async function executeAnySearchDomainLookup(
  args: AnySearchDomainsArgs,
  ctx: AnySearchClientContext,
): Promise<AnySearchDomainsResult> {
  try {
    const content = await callAnySearch(
      'get_sub_domains',
      args.domains.length === 1 ? { domain: args.domains[0] } : { domains: args.domains },
      ctx,
    )
    return { source: 'anysearch', domains: args.domains, content }
  } catch (error) {
    throw new ToolDomainError(
      WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code,
      `AnySearch domain lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      { domains: args.domains },
    )
  }
}
