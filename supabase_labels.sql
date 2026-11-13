-- supabase_labels.sql — memory layer 1 (2026-11-14). ADDITIVE. Run in the Supabase SQL editor.
-- Adds two nullable label columns to memory_embeddings and returns them from the search RPC.
-- Safe to run with the code already deployed: until JARVIS_MEMORY_LABELS=1 is set nothing writes them,
-- and if the flag is set before this runs the code retries the insert without labels.
--
-- STEP 1: the columns.
alter table public.memory_embeddings add column if not exists origin  text;   -- role of the chat it came from: manager | team | trucker | supplier | yard | email
alter table public.memory_embeddings add column if not exists company text;   -- edge_metals | edge_yard

-- STEP 2 (only if you agree every EXISTING row is Edge Metals: the memory code is read only by the Edge Metals WhatsApp assistant).
-- update public.memory_embeddings set company = 'edge_metals' where company is null;

-- STEP 3: the search RPC now also returns the labels. The return type changes, so it must be dropped first.
drop function if exists public.match_memory_embeddings(vector, double precision, integer, text);
create function public.match_memory_embeddings (
    query_embedding vector(768), match_threshold float, match_count int, filter_chat_id text default null
)
returns table (id bigint, chat_id text, text text, type text, created_at timestamptz, similarity float, origin text, company text)
language sql stable
as $$
    select m.id, m.chat_id, m.text, m.type, m.created_at, 1 - (m.embedding <=> query_embedding) as similarity, m.origin, m.company
    from public.memory_embeddings m
    where (filter_chat_id is null or m.chat_id = filter_chat_id)
      and 1 - (m.embedding <=> query_embedding) >= match_threshold
    order by m.embedding <=> query_embedding
    limit match_count;
$$;
