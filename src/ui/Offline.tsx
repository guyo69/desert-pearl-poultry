// What the person sees about the connection: a bar when the app is working
// from the figures kept on the phone, and the entries waiting to be sent,
// with what to do about any the farm could not record.
import { useCallback, useEffect, useState } from 'react';
import { flushOutbox } from '../lib/api';
import { dlabel, timeOf } from '../lib/format';
import { drop, entries, nairobiDay, OUTBOX_EVENT, update, type Entry } from '../lib/outbox';
import { Icon } from './icons';
import { useUI } from './ui';

/** The entries waiting on this phone for a person, kept up to date. */
export function useOutbox(user: string | null): Entry[] {
  const [list, setList] = useState<Entry[]>([]);
  useEffect(() => {
    if (!user) { setList([]); return; }
    let live = true;
    const load = () => entries(user).then((x) => { if (live) setList(x); });
    load();
    addEventListener(OUTBOX_EVENT, load);
    return () => { live = false; removeEventListener(OUTBOX_EVENT, load); };
  }, [user]);
  return list;
}

const when = (iso: string) => (nairobiDay(iso) === nairobiDay(new Date()) ? `today ${timeOf(iso)}` : `${dlabel(nairobiDay(iso))} ${timeOf(iso)}`);

function Waiting({ user }: { user: string }) {
  const list = useOutbox(user), [sure, setSure] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const send = useCallback(async () => { setBusy(true); try { await flushOutbox(user); } finally { setBusy(false); } }, [user]);
  if (!list.length) return <div className="empty"><Icon name="check" />Everything made on this phone has been sent.</div>;
  return <div className="outbox">
    <p className="muted small" style={{ margin: 0 }}>These were saved on this phone with no connection. They are sent on their own when the connection is back, each one once.</p>
    <div className="list">{list.map((e) => <div className="li" key={e.key}>
      <span className="av" style={{ background: `var(${e.status === 'failed' ? '--f-none' : e.status === 'held' ? '--f-low' : '--info'})` }}><Icon name={e.status === 'failed' ? 'alert' : 'clock'} /></span>
      <div className="mid"><b>{e.label}</b><small>Made {when(e.made_at)}</small>
        {e.status === 'held' && <small className="ob-note">Made on an earlier day. Sending it now records it for today. Show it to the farm manager if it must go on its own day.</small>}
        {e.status === 'failed' && <small className="ob-note bad">Not recorded: {e.error}</small>}
        <div className="row-btns" style={{ marginTop: 6 }}>
          {e.status === 'held' && <button className="act" onClick={() => update(e.key, { force: true, status: 'waiting' }).then(send)}>Send for today</button>}
          {e.status === 'failed' && <button className="act" onClick={() => update(e.key, { status: 'waiting', error: undefined }).then(send)}>Try again</button>}
          {e.status !== 'waiting' && (sure === e.key
            ? <button className="act danger" onClick={() => drop(e.key)}>Tap again to remove</button>
            : <button className="act" onClick={() => setSure(e.key)}>Remove</button>)}
        </div></div>
      <div className="end"><small>{e.status === 'failed' ? 'Needs you' : e.status === 'held' ? 'Waiting for you' : 'Waiting'}</small></div>
    </div>)}</div>
    <button className="btn" disabled={busy || !navigator.onLine} onClick={send}>{busy ? 'Sending…' : navigator.onLine ? 'Send now' : 'No connection yet'}</button>
  </div>;
}

export function OfflineBar({ online, stale, user }: { online: boolean; stale: number | null; user: string | null }) {
  const ui = useUI(), list = useOutbox(user);
  const need = list.filter((e) => e.status !== 'waiting').length;
  const open = () => ui.openPanel('Waiting to send', <Waiting user={user!} />);
  const off = !online || stale != null;
  if (!off && !list.length) return null;
  return <div className={`offline-bar${off ? ' off' : ''}${need ? ' need' : ''}`} role="status">
    <Icon name={off ? 'alert' : 'clock'} />
    <span>{off ? <>No connection.{stale != null && <> Figures from {when(new Date(stale).toISOString())}.</>} {user ? 'New entries are saved on this phone.' : 'Entries can be saved once the connection is back.'}</>
      : need ? `${need} entr${need === 1 ? 'y needs' : 'ies need'} you` : `Sending ${list.length} entr${list.length === 1 ? 'y' : 'ies'}…`}
      {off && list.length > 0 && <> {list.length} waiting.</>}</span>
    {user && list.length > 0 && <button className="lnk" onClick={open}>See them</button>}
  </div>;
}
