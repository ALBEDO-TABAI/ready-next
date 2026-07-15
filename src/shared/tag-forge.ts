export const TAG_FORGE_AUTO_SETTING_KEY='tag_forge_auto_enabled'
export interface TagForgeCreationProposalPayload { facet:'form'|'domain'|'entity'|'use';label:string;evidenceCode:string;evidenceExcerpt:string;confidence:number }
export interface TagForgePrepareCreationPayload { sourceRunId:string;path:string;workspaceRoots:string[];content:string;proposals:TagForgeCreationProposalPayload[];creationPending:boolean }
export interface TagForgeFinalizeCreationPayload { receiptId:string;sourceRunId:string;path:string;workspaceRoots:string[] }
export interface TagForgeCreationReceipt { receiptId:string;revision:string;path:string }
