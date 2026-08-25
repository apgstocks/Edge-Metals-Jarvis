-- ════════════════════════════════════════════════════════════════════════════
-- supabase_setup.sql — Jarvis memory schema
--
-- Written 2026-08-25. This file is referenced by comments in
-- helpers/embeddings.js ("see supabase_setup.sql") but has NEVER existed in
-- the repo, which meant the live memory_embeddings table and its RPC were
-- undocumented anywhere: nobody could recreate them, verify them, or tell
-- whether the code's assumptions still matched the database.
--
-- Section 1 DOCUMENTS the table that already exists in production — it was
-- reconstructed from how helpers/embeddings.js actually calls it. Every
-- statement is IF NOT EXISTS / OR REPLACE, so it is safe to run against the
-- live project: it fills in whatever is missing and touches nothing else.
--
-- Section 2 is NEW: a durable replica of facts.json.
--
-- Run: Supabase dashboard -> SQL Editor -> paste -> Run.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists vector;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. memory_embeddings — semantic recall (ALREADY EXISTS IN PRODUCTION)
-- ════════════════════════════════════════════════════════════════════════════
-- 768 dimensions, not 1536: helpers/embeddings.js requests
-- gemini-embedding-001 with outputDimensionality 768 (Matryoshka truncation)
-- and THROWS if the returned vector is any other length. If this column and
-- that constant ever disagree, every store silently fails and semantic recall
-- degrades to nothing, with only a "(non-fatal)" log line to show for it.
create table if not exists public.memory_embeddings (
    id          bigserial primary key,
    chat_id     text,                       -- null for facts (not chat-scoped)
    text        text        not null,
    type        text        not null,       -- 'fact' | 'session_summary'
    embedding   vector(768) not null,
    created_at  timestamptz not null default now()
);

create index if not exists memory_embeddings_type_idx on public.memory_embeddings (type);
create index if not exists memory_embeddings_chat_idx on public.memory_embeddings (chat_id);

-- Retracting a fact deletes its vector row by exact text match (see
-- helpers/embeddings.js's deleteEmbeddingsByText). Without this index that is
-- a sequential scan of the whole table on every retraction.
create index if not exists memory_embeddings_text_idx on public.memory_embeddings (text);

-- ANN index. Build it AFTER the table has a few thousand rows — ivfflat picks
-- its cluster centroids from whatever is present when the index is created,
-- so building it on a near-empty table produces a bad index that silently
-- returns poor matches forever. Until then, exact search is fast enough and
-- is strictly more accurate.
--   create index on public.memory_embeddings
--     using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- The RPC helpers/embeddings.js calls. Argument names must match its
-- rpc('match_memory_embeddings', {...}) payload EXACTLY — PostgREST resolves
-- named arguments, so a rename here is a silent failure at runtime, caught by
-- nothing but a "(non-fatal)" log line.
create or replace function public.match_memory_embeddings (
    query_embedding vector(768),
    match_threshold float,
    match_count     int,
    filter_chat_id  text default null
)
returns table (
    id         bigint,
    chat_id    text,
    text       text,
    type       text,
    created_at timestamptz,
    similarity float
)
language sql stable
as $$
    select
        m.id, m.chat_id, m.text, m.type, m.created_at,
        1 - (m.embedding <=> query_embedding) as similarity
    from public.memory_embeddings m
    where (filter_chat_id is null or m.chat_id = filter_chat_id)
      and 1 - (m.embedding <=> query_embedding) >= match_threshold
    order by m.embedding <=> query_embedding      -- distance ASC = most similar first
    limit match_count;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. facts — durable replica of data/facts.json (NEW)
-- ════════════════════════════════════════════════════════════════════════════
-- WHY A REPLICA, AND NOT THE SOURCE OF TRUTH:
--
-- The original reason for moving facts into Supabase was that a delete could
-- half-succeed — removed from facts.json, left behind in memory_embeddings,
-- then resurrected into the next prompt by semantic recall. That hole is
-- already closed, twice, by phase 1: the delete now removes the vector row,
-- AND helpers/context.js filters every semantic hit against the local
-- believable set, so a stale row cannot reach a prompt even if the delete
-- never landed.
--
-- What is NOT solved is durability. Every fact Apsara has taught Jarvis lives
-- in one JSON file, on one VM, with no backup of any kind. That is the real
-- remaining risk, and a replica fixes it without the costs of making Supabase
-- primary:
--   - reads stay local, so phase 4's retrieval stays pure and off the network
--   - a Supabase outage cannot stop her teaching Jarvis something
--   - the whole thing stays testable from a machine with no network access
--
-- Columns mirror helpers/json.js's normaliseFact() exactly. `id` is the
-- application's own derived/ULID id, never a database sequence, so a fact has
-- ONE identity everywhere and a restore is byte-identical to what was
-- replicated.
create table if not exists public.facts (
    id             text primary key,
    text           text        not null,
    pinned         boolean     not null default false,

    -- validity (phase 2)
    status         text        not null default 'active',   -- active|superseded|retracted
    valid_from     timestamptz,
    valid_until    timestamptz,
    recorded_at    timestamptz,
    created_at     timestamptz,

    -- lineage (phase 2)
    supersedes     jsonb       not null default '[]'::jsonb,
    superseded_by  text,
    change_reason  text,
    retracted_at   timestamptz,

    -- provenance (phase 3)
    origin         text        not null default 'manager',  -- manager|trusted_tool|agent|external
    authority      text        not null default 'act',      -- act|inform|none
    derived_from   jsonb       not null default '[]'::jsonb,
    proposed_by    text,

    -- strength (phase 4)
    confirmations    int       not null default 0,
    recall_count     int       not null default 0,
    last_recalled_at timestamptz,
    importance       int       not null default 5,

    replicated_at  timestamptz not null default now()
);

create index if not exists facts_status_idx on public.facts (status);
create index if not exists facts_origin_idx on public.facts (origin);
-- Phase 2's "what did Jarvis believe on date X" query.
create index if not exists facts_validity_idx on public.facts (valid_from, valid_until);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. VERIFY — run these after the above
-- ════════════════════════════════════════════════════════════════════════════
-- All three must return a row. If the second returns anything other than
-- `vector`, or the third returns nothing, semantic memory is not working and
-- has been failing silently.
--
--   select count(*) from public.memory_embeddings;
--   select pg_typeof(embedding) from public.memory_embeddings limit 1;
--   select proname from pg_proc where proname = 'match_memory_embeddings';
--
-- Confirm the RPC actually answers. Zero rows is fine; an ERROR is not:
--
--   select * from public.match_memory_embeddings(
--     (select embedding from public.memory_embeddings limit 1), 0.0, 1, null);
--
-- After the first replication run, this should match the number of facts in
-- data/facts.json on the VM:
--
--   select status, count(*) from public.facts group by status;
