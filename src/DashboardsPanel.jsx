import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Clock, Zap, TrendingUp, AlertTriangle, Trophy } from 'lucide-react';
import { api } from './api';
import { silk } from './engine/motion';

/* ---------------------------------------------------------------- primitives */

const COLORS = {
  created: 'var(--primary, #8b5cf6)',
  resolved: 'var(--status-available, #10b981)',
  warn: 'var(--status-maintenance, #f59e0b)',
  danger: 'var(--status-disposed, #ef4444)',
  info: 'var(--status-assigned, #3b82f6)'
};

const fmtHours = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : `${h}h`);
const fmtPct = (p) => (p == null ? '—' : `${p}%`);

// A horizontal-bar breakdown, matching the asset dashboard's hbar style.
const Breakdown = ({ title, data, color }) => {
  const entries = Object.entries(data || {});
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="card">
      <span className="card-title">{title}</span>
      {entries.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>No data.</div>}
      <div className="hbar-list">
        {entries.map(([k, v]) => (
          <div key={k} className="hbar-row">
            <span className="hbar-label">{k}</span>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${(v / max) * 100}%`, ...(color ? { background: color } : {}) }} />
            </div>
            <span className="hbar-count">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Compliance meter: a big percentage over a proportional bar, coloured by health.
const ComplianceMeter = ({ label, value, sub }) => {
  const tone = value == null ? 'var(--text-muted)' : value >= 90 ? COLORS.resolved : value >= 70 ? COLORS.warn : COLORS.danger;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <span className="card-title">{label}</span>
      <span style={{ fontSize: '38px', fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', color: tone, lineHeight: 1 }}>{fmtPct(value)}</span>
      <div style={{ height: '10px', borderRadius: '999px', background: 'var(--border-color)', overflow: 'hidden' }}>
        <div style={{ width: `${value || 0}%`, height: '100%', background: tone, transition: 'width .4s ease' }} />
      </div>
      {sub && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{sub}</span>}
    </div>
  );
};

// Dual-line 30-day trend (created vs resolved), drawn as a responsive SVG.
const TrendChart = ({ trend = [] }) => {
  const W = 720, H = 200, P = 24;
  if (trend.length === 0) {
    return (
      <div className="card">
        <span className="card-title"><TrendingUp size={13} style={{ verticalAlign: '-2px' }} /> Ticket Trend — last 30 days</span>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>No trend data yet.</div>
      </div>
    );
  }
  const max = Math.max(1, ...trend.flatMap((d) => [d.created, d.resolved]));
  const x = (i) => P + (i / Math.max(1, trend.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const line = (key) => trend.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
  const area = (key) => `${line(key)} L ${x(trend.length - 1)} ${H - P} L ${x(0)} ${H - P} Z`;

  return (
    <div className="card">
      <span className="card-title"><TrendingUp size={13} style={{ verticalAlign: '-2px' }} /> Ticket Trend — last 30 days</span>
      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', margin: '4px 0 10px' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: COLORS.created, marginRight: 5 }} />Created</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: COLORS.resolved, marginRight: 5 }} />Resolved</span>
      </div>
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: '480px', height: 'auto', display: 'block' }} role="img" aria-label="Ticket creation and resolution trend">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={P} x2={W - P} y1={y(max * f)} y2={y(max * f)} stroke="var(--border-color)" strokeWidth="1" />
          ))}
          <path d={area('created')} fill={COLORS.created} opacity="0.08" />
          <path d={line('created')} fill="none" stroke={COLORS.created} strokeWidth="2" />
          <path d={line('resolved')} fill="none" stroke={COLORS.resolved} strokeWidth="2" />
          {[0, Math.floor(trend.length / 2), trend.length - 1].map((i) => (
            <text key={i} x={x(i)} y={H - 6} fontSize="10" fill="var(--text-muted)" textAnchor="middle">{trend[i]?.date.slice(5)}</text>
          ))}
        </svg>
      </div>
    </div>
  );
};

const StatStrip = ({ items }) => (
  <div className="stat-strip">
    {items.map((it) => (
      <div className="stat-cell" key={it.label}>
        <span className="stat-label">{it.label}</span>
        <span className="stat-value" style={it.color ? { color: it.color } : undefined}>{it.value}</span>
        <span className={`stat-note ${it.alert ? 'alert' : ''}`}>{it.note}</span>
      </div>
    ))}
  </div>
);

/* -------------------------------------------------------------- dashboards */

const TicketDash = ({ data }) => {
  const counts = data.counts || {};
  return (
  <>
    <StatStrip items={[
      { label: 'Open', value: counts.open ?? 0, note: 'Awaiting pickup' },
      { label: 'In Progress', value: counts.inProgress ?? 0, note: 'Being worked' },
      { label: 'Pending', value: counts.pending ?? 0, note: 'On hold / waiting' },
      { label: 'Unassigned', value: counts.unassigned ?? 0, note: 'No agent', alert: counts.unassigned > 0 },
      { label: 'Reopened', value: counts.reopened ?? 0, note: 'Bounced back', alert: counts.reopened > 0 },
      { label: 'Resolved', value: (counts.resolved ?? 0) + (counts.closed ?? 0), note: 'Resolved + closed' }
    ]} />
    <div className="stat-strip">
      <div className="stat-cell"><span className="stat-label">Avg Resolution Time</span><span className="stat-value">{fmtHours(data.avgResolutionHours)}</span><span className="stat-note">Creation → resolved</span></div>
      <div className="stat-cell"><span className="stat-label">Avg First Response</span><span className="stat-value">{fmtHours(data.avgFirstResponseHours)}</span><span className="stat-note">Creation → first reply</span></div>
      <div className="stat-cell"><span className="stat-label">Assigned</span><span className="stat-value">{counts.assigned ?? 0}</span><span className="stat-note">Have an agent</span></div>
      <div className="stat-cell"><span className="stat-label">Total</span><span className="stat-value">{counts.total ?? 0}</span><span className="stat-note">All tickets</span></div>
    </div>
    <TrendChart trend={data.trend} />
    <div className="dashboard-grid-secondary">
      <Breakdown title="By Priority" data={data.byPriority} />
      <Breakdown title="By Category" data={data.byCategory} />
    </div>
    <div className="dashboard-grid-secondary">
      <Breakdown title="By Department" data={data.byDepartment} />
      <Breakdown title="By Branch / Location" data={data.byBranch} />
    </div>
  </>
  );
};

const SlaDash = ({ data }) => {
  // Never assume the nested objects are present — a partial payload should degrade
  // to em-dashes/zeroes, not crash reading `.resolution` off undefined.
  const compliance = data.compliance || {};
  const counts = data.counts || {};
  return (
    <>
      <div className="dashboard-grid-secondary">
        <ComplianceMeter label="Resolution SLA Compliance" value={compliance.resolution}
          sub={`${counts.closedTotal ?? 0} closed ticket(s) measured`} />
        <ComplianceMeter label="Response SLA Compliance" value={compliance.response}
          sub="Share of tickets first-answered on time" />
      </div>
      <StatStrip items={[
        { label: 'Breached (open)', value: counts.breachedOpen ?? 0, note: 'Past due, still open', alert: counts.breachedOpen > 0, color: counts.breachedOpen > 0 ? COLORS.danger : undefined },
        { label: 'Approaching', value: counts.approaching ?? 0, note: `Due within ${data.warningHours ?? 8}h`, alert: counts.approaching > 0, color: counts.approaching > 0 ? COLORS.warn : undefined },
        { label: 'Escalated', value: counts.escalated ?? 0, note: 'Reached a level', alert: counts.escalated > 0 },
        { label: 'Resolution Breaches', value: counts.resolutionBreached ?? 0, note: 'All time' },
        { label: 'Response Breaches', value: counts.responseBreached ?? 0, note: 'All time' }
      ]} />
      <div className="stat-strip">
        <div className="stat-cell"><span className="stat-label">Avg Response Time</span><span className="stat-value">{fmtHours(data.avgResponseHours)}</span><span className="stat-note">To first reply</span></div>
        <div className="stat-cell"><span className="stat-label">Avg Resolution Time</span><span className="stat-value">{fmtHours(data.avgResolutionHours)}</span><span className="stat-note">To resolved</span></div>
        <div className="stat-cell"><span className="stat-label">Under SLA</span><span className="stat-value">{counts.withSla ?? 0}</span><span className="stat-note">Governed by a policy</span></div>
      </div>
      <Breakdown title="Escalations by Level" data={data.escalationsByLevel} color={COLORS.danger} />
    </>
  );
};

const TechDash = ({ data }) => {
  const technicians = data.technicians || [];
  const maxLoad = Math.max(1, ...technicians.map((t) => t.assigned));
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <span className="card-title"><Trophy size={13} style={{ verticalAlign: '-2px' }} /> Technician Performance</span>
      {technicians.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>No assigned tickets yet.</div>}
      {technicians.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '640px' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>
              <th style={{ padding: '8px 6px' }}>#</th>
              <th style={{ padding: '8px 6px' }}>Technician</th>
              <th style={{ padding: '8px 6px' }}>Workload</th>
              <th style={{ padding: '8px 6px' }}>Assigned</th>
              <th style={{ padding: '8px 6px' }}>Resolved</th>
              <th style={{ padding: '8px 6px' }}>Avg Res.</th>
              <th style={{ padding: '8px 6px' }}>SLA</th>
            </tr>
          </thead>
          <tbody>
            {technicians.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '8px 6px', fontWeight: 800 }}>{t.rank}</td>
                <td style={{ padding: '8px 6px' }}>
                  <div style={{ fontWeight: 700 }}>{t.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t.role}{t.department ? ` · ${t.department}` : ''}</div>
                </td>
                <td style={{ padding: '8px 6px', minWidth: '140px' }}>
                  <div className="hbar-track" style={{ marginBottom: '2px' }}>
                    <div className="hbar-fill" style={{ width: `${(t.openWorkload / maxLoad) * 100}%`, background: t.openWorkload > maxLoad * 0.75 ? COLORS.danger : COLORS.info }} />
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t.openWorkload} open</span>
                </td>
                <td style={{ padding: '8px 6px' }}>{t.assigned}</td>
                <td style={{ padding: '8px 6px' }}>{t.resolved}</td>
                <td style={{ padding: '8px 6px' }}>{fmtHours(t.avgResolutionHours)}</td>
                <td style={{ padding: '8px 6px', fontWeight: 700, color: t.slaCompliance == null ? 'var(--text-muted)' : t.slaCompliance >= 90 ? COLORS.resolved : t.slaCompliance >= 70 ? COLORS.warn : COLORS.danger }}>
                  {fmtPct(t.slaCompliance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ panel */

const FETCHERS = {
  tickets: api.getTicketDashboard,
  sla: api.getSlaDashboard,
  technicians: api.getTechnicianDashboard
};

const DashboardsPanel = ({ view, addToast }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which view the data in state actually belongs to. Each dashboard has a
  // different shape (only the SLA payload has `compliance`, only the technician
  // one has `technicians`), and switching `view` re-renders with the *previous*
  // view's data still in state for one tick before the new fetch resolves.
  // Rendering e.g. SlaDash against ticket data threw "reading 'resolution'";
  // gating on this makes that stale cross-shape render impossible.
  const [loadedView, setLoadedView] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetcher = FETCHERS[view];
      const result = await fetcher();
      setData(result);
      setLoadedView(view);
    } catch (err) {
      setError(err.message);
      addToast?.('Dashboard failed', err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="card" style={{ padding: '30px', textAlign: 'center', color: 'var(--status-disposed)' }}><AlertTriangle size={16} /> {error}</div>;
  if (loading || !data || loadedView !== view) return <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading dashboard…</div>;

  return (
    <motion.div {...silk} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {view === 'tickets' && <TicketDash data={data} />}
      {view === 'sla' && <SlaDash data={data} />}
      {view === 'technicians' && <TechDash data={data} />}
    </motion.div>
  );
};

export default DashboardsPanel;
