-- =============================================================================
-- public.email_verifications
--
-- Tabla para verificación de email del cliente durante el form web. Flujo:
--   1. Cliente escribe email en el form → presiona "Verificar email"
--   2. n8n workflow "CFL - Email: Verify Send Code":
--        * Genera código 6 dígitos
--        * INSERT en email_verifications con code_hash (SHA256) + expires_at
--          (10 min) + tracking_id de la sesión
--        * Envía email con el código vía proxy Outlook
--   3. Cliente ingresa código → form llama n8n "Verify Confirm Code"
--        * Busca fila por (email, tracking_id) más reciente NO expirada
--        * Compara hash del input vs code_hash
--        * Si OK: marca verified_at = NOW(), responde {ok:true}
--        * Si NO OK: incrementa attempts. Si attempts >= max_attempts (3),
--          expira la fila (expires_at = NOW()).
--   4. El form web NO permite submit sin verified_at IS NOT NULL en una fila
--      reciente para (email, tracking_id).
--
-- Privacidad: NUNCA se guarda el código en plaintext. Solo SHA256.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.email_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    code_hash       TEXT NOT NULL,   -- SHA256 hex del código de 6 dígitos
    tracking_id     UUID NOT NULL,   -- correlaciona con la sesión del form

    -- Reloj
    expires_at      TIMESTAMPTZ NOT NULL,
    verified_at     TIMESTAMPTZ,     -- NULL hasta que se confirme
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Anti-bruteforce
    attempts        SMALLINT NOT NULL DEFAULT 0,
    max_attempts    SMALLINT NOT NULL DEFAULT 3,

    -- Para limitar reenvíos seguidos (cooldown 60s manejado por el workflow)
    last_sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup principal: buscar el código activo más reciente para (email, tracking_id)
CREATE INDEX IF NOT EXISTS email_verifications_lookup_idx
    ON public.email_verifications (email, tracking_id, created_at DESC)
    WHERE verified_at IS NULL;

-- Cleanup query (correr periódicamente desde n8n cron, no por trigger):
--   DELETE FROM public.email_verifications
--    WHERE expires_at < NOW() - INTERVAL '1 day' AND verified_at IS NULL;
-- (Los verificados se preservan unos días como auditoría.)
