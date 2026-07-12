export const TAG_FORGE_AUTO_SETTING_KEY='tag_forge_auto_enabled'
export interface TagForgeBeginCreationPayload { sourceRunId:string }
export interface TagForgeRecordCreationPayload { creationToken:string;sourceRunId:string;path:string;workspaceRoots:string[] }
export interface TagForgeFinalizeCreationPayload { creationToken:string;receiptId:string;sourceRunId:string;path:string;workspaceRoots:string[] }
export interface TagForgeCreationReceipt { receiptId:string;revision:string;path:string }
export interface TagForgePendingProposalView { proposalId:string;facet:string;label:string;evidenceCode:string;evidenceExcerpt:string|null }
