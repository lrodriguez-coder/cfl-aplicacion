-- =============================================================
-- CFL - Almacenamiento de documentos del formulario web
-- =============================================================
-- Database : cfl (AWS RDS PostgreSQL)
-- Fecha    : 2026-05-18
-- Proposito: Registrar cada documento subido desde el formulario
--            web. El archivo se guarda en S3 (cfl-documentos-2026)
--            y aqui queda la referencia. Se enlaza a la aplicacion
--            (aplicacion_id) cuando el cliente entrega la solicitud,
--            y el job de OneDrive marca copiado_onedrive=TRUE.
-- =============================================================

CREATE TABLE IF NOT EXISTS web_doc_uploads (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracking_id      TEXT NOT NULL,
  aplicacion_id    UUID REFERENCES aplicaciones(id),
  doc_type         VARCHAR(40) NOT NULL,
  idx              SMALLINT NOT NULL DEFAULT 0,
  s3_key           TEXT NOT NULL,
  s3_url           TEXT,
  file_name        VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wdu_tracking   ON web_doc_uploads (tracking_id);
CREATE INDEX IF NOT EXISTS idx_wdu_aplicacion ON web_doc_uploads (aplicacion_id);

COMMENT ON TABLE web_doc_uploads IS
  'Documentos subidos desde el formulario web. El archivo vive en S3; aqui la referencia.';
COMMENT ON COLUMN web_doc_uploads.tracking_id IS 'tracking_id del formulario (localStorage cfl_tracking_id).';
COMMENT ON COLUMN web_doc_uploads.aplicacion_id IS 'Se rellena al entregar la solicitud (enlace a aplicaciones).';

DO $body$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cfl_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON web_doc_uploads TO cfl_app';
  END IF;
END $body$;

-- =============================================================
-- END web_doc_uploads.sql
-- =============================================================
