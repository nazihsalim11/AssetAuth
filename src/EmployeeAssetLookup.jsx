import React, { useState, useEffect, useCallback } from 'react';
import { Search, User, Package, History, Mail, Briefcase, IdCard } from 'lucide-react';
import { api } from './api';

/**
 * Employee Asset Lookup.
 *
 * Search the directory by name, employee ID, username or email, then show what the
 * person currently holds and everything they have ever held.
 *
 * Both endpoints are scoped server-side: an Employee can only ever find and inspect
 * themselves, so this component needs no role checks of its own.
 */
const EmployeeAssetLookup = ({ addToast }) => {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [selected, setSelected] = useState(null);
  const [details, setDetails] = useState(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);

  const runSearch = useCallback(async (q) => {
    if (q.trim().length < 2) {
      setMatches([]);
      return;
    }
    setSearching(true);
    try {
      setMatches(await api.searchEmployees(q.trim()));
    } catch (err) {
      addToast('Search failed', err.message || 'Could not search the directory.', 'error');
    } finally {
      setSearching(false);
    }
  }, [addToast]);

  // Debounced so each keystroke does not hit the directory.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 300);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const openEmployee = async (employee) => {
    setSelected(employee);
    setLoading(true);
    try {
      setDetails(await api.getEmployeeAssets(employee.id));
    } catch (err) {
      addToast('Error', err.message || 'Could not load this employee\'s assets.', 'error');
      setDetails(null);
    } finally {
      setLoading(false);
    }
  };

  const returned = (details?.history || []).filter((h) => h.status !== 'Assigned');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <span className="card-title"><Search /> Find an Employee</span>
        <div className="search-bar-container" style={{ height: '42px' }}>
          <Search className="search-icon" />
          <input
            className="search-bar"
            placeholder="Search by name, employee ID, username or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {query.trim().length >= 2 && (
          <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            {searching ? (
              <div style={{ padding: '14px' }}><div className="skeleton skeleton-text" /></div>
            ) : matches.length === 0 ? (
              <div style={{ padding: '16px', fontSize: '12.5px', color: 'var(--text-muted)', textAlign: 'center' }}>
                No active employee matches “{query}”.
              </div>
            ) : (
              matches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => openEmployee(m)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
                    padding: '10px 14px', background: selected?.id === m.id ? 'var(--primary-soft)' : 'transparent',
                    border: 'none', borderBottom: '1px solid var(--border-color)', cursor: 'pointer', textAlign: 'left'
                  }}
                >
                  <div className="avatar" style={{ width: 30, height: 30, fontSize: 10 }}>
                    {m.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{m.name}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                      {[m.employeeId, m.username, m.email, m.department].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {loading && (
        <div className="card"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-row" /></div>
      )}

      {!loading && details && (
        <>
          <div className="card">
            <span className="card-title"><User /> {details.employee.name}</span>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              {details.employee.employeeId && <span><IdCard size={13} style={{ verticalAlign: '-2px' }} /> {details.employee.employeeId}</span>}
              {details.employee.email && <span><Mail size={13} style={{ verticalAlign: '-2px' }} /> {details.employee.email}</span>}
              {details.employee.department && <span><Briefcase size={13} style={{ verticalAlign: '-2px' }} /> {details.employee.department}{details.employee.designation ? ` — ${details.employee.designation}` : ''}</span>}
              <span className={`badge ${details.employee.status === 'Active' ? 'badge-available' : 'badge-disposed'}`}>{details.employee.status}</span>
            </div>
          </div>

          <div className="stat-strip">
            <div className="stat-cell">
              <span className="stat-label">Assets currently held</span>
              <span className="stat-value">{details.currentAssets.length}</span>
            </div>
            <div className="stat-cell">
              <span className="stat-label">Total quantity</span>
              <span className="stat-value">{details.totalQuantityHeld}</span>
            </div>
            <div className="stat-cell">
              <span className="stat-label">Lifetime assignments</span>
              <span className="stat-value">{details.history.length}</span>
            </div>
          </div>

          <div className="card">
            <span className="card-title"><Package /> Currently Assigned</span>
            <div className="table-container" style={{ maxHeight: '360px' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Asset Code</th><th>Asset Name</th><th>Category</th><th>Serial</th>
                    <th>Qty</th><th>Department</th><th>Location</th><th>Assigned On</th>
                  </tr>
                </thead>
                <tbody>
                  {details.currentAssets.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <div className="empty-state">
                          <div className="empty-state-icon"><Package size={22} /></div>
                          <div className="empty-state-title">No assets currently assigned</div>
                          <div className="empty-state-desc">This employee is not holding any assets right now.</div>
                        </div>
                      </td>
                    </tr>
                  ) : details.currentAssets.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 700, color: 'var(--primary)' }}>{a.assetId}</td>
                      <td>{a.assetName}</td>
                      <td>{a.assetCategory}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>{a.serialNumber || '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{a.quantity}</td>
                      <td>{a.department || '—'}</td>
                      <td>{a.location || '—'}</td>
                      <td style={{ fontSize: '12px' }}>{a.date ? new Date(a.date).toLocaleDateString('en-IN') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <span className="card-title"><History /> Assignment History</span>
            {returned.length === 0 ? (
              <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                No returned or historical assignments — every record for this employee is currently active.
              </span>
            ) : (
              <div className="table-container" style={{ maxHeight: '320px' }}>
                <table className="data-table">
                  <thead>
                    <tr><th>Asset Code</th><th>Asset Name</th><th>Qty</th><th>Status</th><th>Assigned On</th><th>Notes</th></tr>
                  </thead>
                  <tbody>
                    {returned.map((h) => (
                      <tr key={h.id}>
                        <td style={{ fontWeight: 700 }}>{h.assetId}</td>
                        <td>{h.assetName}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{h.quantity}</td>
                        <td><span className="badge">{h.status}</span></td>
                        <td style={{ fontSize: '12px' }}>{h.date ? new Date(h.date).toLocaleDateString('en-IN') : '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{h.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {!loading && !details && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><User size={22} /></div>
            <div className="empty-state-title">Search for an employee</div>
            <div className="empty-state-desc">
              Look someone up by name, employee ID, username or email to see the assets in their custody.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmployeeAssetLookup;
