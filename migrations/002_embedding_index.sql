-- Approximate nearest-neighbour index for cosine distance (requires pgvector >= 0.5).
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx ON rag_chunks USING hnsw (embedding vector_cosine_ops);
