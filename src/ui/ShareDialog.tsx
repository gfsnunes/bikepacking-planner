import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { SYNC_URL } from '../sync/client';
import { createShare, deleteShare, leaveShare, shareLinks } from '../sync/session';

/** Header control: "Save & share" before sharing, a status pill after. */
export function ShareButton() {
  const share = useStore((s) => s.share);
  const open = () => useStore.getState().setShareOpen(true);
  if (!SYNC_URL) return null; // sharing not configured for this build
  if (!share) return <button onClick={open}>Save &amp; share</button>;
  const label =
    share.status === 'connecting'
      ? 'Connecting…'
      : share.status === 'offline'
        ? 'Offline · will resync'
        : `${share.canWrite ? 'Shared' : 'View only'} · ${share.peers} here`;
  return (
    <button className={`share-pill ${share.status}`} onClick={open} title="Shared trip: links and options">
      <span className="dot" aria-hidden="true" />
      {label}
    </button>
  );
}

function LinkRow({ label, url, note }: { label: string; url: string; note: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      input.current?.select(); // clipboard blocked: leave it selected for Ctrl+C
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="share-link">
      <label>
        <strong>{label}</strong> <span className="hint">{note}</span>
        <span className="share-link-row">
          <input ref={input} readOnly value={url} onFocus={(e) => e.target.select()} />
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </span>
      </label>
    </div>
  );
}

export function ShareDialog() {
  const open = useStore((s) => s.shareOpen);
  const share = useStore((s) => s.share);
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Native listeners: React's onClose/onCancel don't fire reliably for <dialog> (see Welcome).
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onClosed = () => useStore.getState().shareOpen && useStore.getState().setShareOpen(false);
    d.addEventListener('close', onClosed);
    d.addEventListener('cancel', onClosed);
    return () => {
      d.removeEventListener('close', onClosed);
      d.removeEventListener('cancel', onClosed);
    };
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await createShare();
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? 'Could not reach the sharing server. Check your connection.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!share || !confirm('Delete this shared trip for everyone? Anyone with the links loses access. Your copy here stays.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteShare(share.keys);
      useStore.getState().setShareOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const links = share ? shareLinks(share.keys) : null;
  const close = () => useStore.getState().setShareOpen(false);

  return (
    <dialog ref={dialog} className="about share">
      <h2>Save &amp; share</h2>
      {!share ? (
        <>
          <p>Put this trip online so others can plan it with you. Everyone with the edit link sees changes live.</p>
          <ul>
            <li>No accounts: the link is the key. Anyone you give the edit link to can change or delete the trip.</li>
            <li>
              The trip is encrypted in your browser before it leaves it. The key is part of the link and never reaches our server, so
              nobody, including us, can read the trip or recover it if the link is lost.
            </li>
            <li>Links can't be withdrawn. To stop sharing, delete the shared trip and share again.</li>
            <li>A shared trip is deleted 90 days after its last change.</li>
          </ul>
          {error && <p className="error-text">{error}</p>}
          <div className="welcome-actions">
            <button className="primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : 'Create shared trip'}
            </button>
            <button className="link" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {share.canWrite ? 'You can edit this trip.' : 'You have a view-only link: you see changes live but can’t edit.'}{' '}
            {share.peers > 1 ? `${share.peers} browsers have it open now.` : 'Nobody else has it open right now.'}
          </p>
          {links?.edit && <LinkRow label="Edit link" url={links.edit} note="lets people change and delete the trip" />}
          {links && <LinkRow label="View-only link" url={links.view} note="lets people follow along" />}
          <p className="hint">Keep the links like a password: they are the only key to the trip. Deleted 90 days after the last change.</p>
          {error && <p className="error-text">{error}</p>}
          <div className="welcome-actions">
            <button onClick={close}>Close</button>
            <button
              onClick={() => {
                leaveShare();
                close();
              }}
              title="Disconnect; keep a copy in this browser. The shared trip stays online."
            >
              Leave shared trip
            </button>
            {share.canWrite && (
              <button className="danger" disabled={busy} onClick={remove}>
                Delete shared trip
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
