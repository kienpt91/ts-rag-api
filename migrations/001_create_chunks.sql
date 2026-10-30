CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id          text PRIMARY KEY,
  document_id text NOT NULL,
  title       text NOT NULL,
  source      text,
  heading     text NOT NULL DEFAULT '',
  position    integer NOT NULL,
  text        text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector({{dimensions}}) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_chunks_document_id_idx ON rag_chunks (document_id);

CREATE INDEX IF NOT EXISTS rag_chunks_metadata_idx ON rag_chunks USING gin (metadata jsonb_path_ops);
