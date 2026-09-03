-- Schema-only capture of an existing pre-118 database upgraded through 113.
-- Earlier events predate memory-redaction evidence; no user row data is included.
CREATE TABLE ready_model_gateway_exchange_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_request_receipt_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('request_admitted', 'response_completed')),
  instruction_digest TEXT,
  input_digest TEXT,
  input_items_json TEXT,
  input_total_string_characters INTEGER,
  input_max_string_characters INTEGER,
  tools_digest TEXT,
  tool_count INTEGER,
  body_bytes INTEGER,
  response_id TEXT,
  terminal_digest TEXT,
  output_digest TEXT,
  usage_digest TEXT,
  evidence_digest TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  memory_history_redaction_digest TEXT CHECK (memory_history_redaction_digest IS NULL OR (
    length(memory_history_redaction_digest) = 64
    AND memory_history_redaction_digest NOT GLOB '*[^0-9a-f]*'
  )),
  memory_history_redacted_item_count INTEGER CHECK (
    memory_history_redacted_item_count IS NULL OR memory_history_redacted_item_count >= 0
  ),
  FOREIGN KEY (gateway_request_receipt_id) REFERENCES ready_model_gateway_request_receipts(receipt_id),
  UNIQUE(gateway_request_receipt_id, event_kind),
  CHECK (
    (event_kind = 'request_admitted'
      AND instruction_digest IS NOT NULL AND input_digest IS NOT NULL
      AND input_items_json IS NOT NULL AND json_valid(input_items_json)
      AND json_type(input_items_json) = 'array'
      AND input_total_string_characters >= 0 AND input_max_string_characters >= 0
      AND input_total_string_characters >= input_max_string_characters
      AND tools_digest IS NOT NULL AND tool_count >= 0 AND body_bytes > 0
      AND response_id IS NULL AND terminal_digest IS NULL
      AND output_digest IS NULL AND usage_digest IS NULL)
    OR
    (event_kind = 'response_completed'
      AND instruction_digest IS NULL AND input_digest IS NULL AND input_items_json IS NULL
      AND input_total_string_characters IS NULL AND input_max_string_characters IS NULL
      AND tools_digest IS NULL AND tool_count IS NULL AND body_bytes IS NULL
      AND response_id IS NOT NULL AND terminal_digest IS NOT NULL
      AND output_digest IS NOT NULL AND usage_digest IS NOT NULL)
  )
);
