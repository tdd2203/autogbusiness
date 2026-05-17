"""Manual apply migration 0007 (billing_invoices) when alembic upgrade doesn't commit."""
import psycopg

URL = "postgresql://autogpt:autogpt@localhost:5432/autogpt_dashboard"
with psycopg.connect(URL, autocommit=True) as conn:
    cur = conn.cursor()
    cur.execute(
        "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_invoices JSONB"
    )
    cur.execute(
        "UPDATE alembic_version SET version_num='0007_workspace_billing_invoices'"
    )
    cur.execute("SELECT version_num FROM alembic_version")
    print("version:", cur.fetchone())
    cur.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name='workspaces' AND column_name='billing_invoices'"
    )
    print("column:", cur.fetchone())
