import { useState } from 'react'
import CustomSelect from '../../CustomSelect'
import { RefreshCw, Search, Download } from 'lucide-react'
import { SpinnerButton } from '../../SpinnerButton'
import { formatINR } from '../../utils/format'
import { useAppData } from '../../context/AppDataContext'
import BulkManager from '../../BulkManager'

export default function AmcPage() {
  const { addingAmc, addingServiceRecord, amcSearch, amcs, assets, filteredAmcs, handleAddAMC, handleAddAMCServiceRecord, handleMapAssetToAmc, hasPermission, mapAmcId, mapAssetId, mappingAmcAsset, newAmcServiceSchedule, setAmcSearch, setMapAmcId, setMapAssetId, setNewAmcServiceSchedule, vendors, newAmcVendorId, setNewAmcVendorId, refreshAmcs, addToast } = useAppData();
  const [showBulk, setShowBulk] = useState(false);

  return (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Maintenance Agreements</span>
                  <h1 className="page-title">Annual Maintenance Contracts</h1>
                  <span className="page-subtitle">Track vendor support contracts, SLA agreements, and servicing histories</span>
                </div>
                {hasPermission('finance') && (
                  <div className="page-actions" style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-secondary" onClick={() => setShowBulk(true)} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Download size={15} /> Bulk manage
                    </button>
                  </div>
                )}
              </div>

              <BulkManager entity="amc" isOpen={showBulk} onClose={() => setShowBulk(false)} onComplete={refreshAmcs} addToast={addToast} />

              <div className="stat-strip" style={{ marginBottom: '24px' }}>
                <div className="stat-cell">
                  <span className="stat-label">Active AMC Contracts</span>
                  <span className="stat-value">{amcs.length}</span>
                  <span className="stat-note">Vendor support contracts</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-label">Total AMC Spend</span>
                  <span className="stat-value">{formatINR(amcs.reduce((acc, curr) => acc + Number(curr.cost || 0), 0))}</span>
                  <span className="stat-note">Annual cost total (INR)</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-label">Service Actions Logged</span>
                  <span className="stat-value">{amcs.reduce((acc, curr) => acc + (curr.serviceHistory || []).length, 0)}</span>
                  <span className="stat-note">Maintenance logs</span>
                </div>
              </div>

              <div className="dashboard-grid-secondary">
                {/* Register contract */}
                <div className="card">
                  <span className="card-title">Register Maintenance Agreement</span>
                  {hasPermission('finance') ? (
                    <form onSubmit={handleAddAMC} className="form-grid">
                      <div className="form-group full-width">
                        <label className="form-label">PO Number *</label>
                        <input type="text" name="poNumber" placeholder="e.g. PO-2026-014" className="form-input" required />
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          The contract's business identifier. Must be unique across all AMCs.
                        </span>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Support Vendor Partner *</label>
                        <CustomSelect
                          name="vendorId"
                          value={newAmcVendorId}
                          onChange={(e) => setNewAmcVendorId(e.target.value)}
                          searchable
                          required
                          placeholder={vendors.length ? 'Select a vendor…' : 'No vendors in registry'}
                          searchPlaceholder="Search vendors…"
                          options={vendors.map(v => ({ value: String(v.id), label: v.name }))}
                        />
                        {vendors.length === 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            Add vendors in the Vendor Registry (Purchase Orders → Vendors) before registering an AMC.
                          </span>
                        )}
                      </div>
                      <div className="form-group">
                        <label className="form-label">Annual Cost (₹)</label>
                        <input type="number" name="cost" placeholder="e.g. 500" className="form-input" required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Contract Start Date</label>
                        <input type="date" name="startDate" className="form-input" required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Contract End Date</label>
                        <input type="date" name="endDate" className="form-input" required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Service Interval Schedule</label>
                        <CustomSelect
                          name="serviceSchedule"
                          options={[
                            { value: "Monthly", label: "Monthly" },
                            { value: "Quarterly", label: "Quarterly" },
                            { value: "Bi-Annual", label: "Bi-Annual" },
                            { value: "Annual", label: "Annual" }
                          ]}
                          value={newAmcServiceSchedule}
                          onChange={(e) => setNewAmcServiceSchedule(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">SLA Agreement Document</label>
                        <input type="file" name="agreementFile" className="form-input" required />
                      </div>
                      <div className="form-group full-width" style={{ marginTop: '8px' }}>
                        <SpinnerButton type="submit" className="btn btn-primary" style={{ width: '100%' }} loading={addingAmc} loadingText="Registering…">Save &amp; Register AMC</SpinnerButton>
                      </div>
                    </form>
                  ) : (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', padding: '24px' }}>
                      Only Finance Team and Admin roles are authorized to create support contracts.
                    </div>
                  )}
                </div>

                {/* Map asset to contract */}
                <div className="card">
                  <span className="card-title">Map Asset to Contract</span>
                  {hasPermission('finance') ? (
                    <form onSubmit={(e) => {
                      e.preventDefault();
                      const amcId = e.target.amcId.value;
                      const assetId = e.target.assetId.value;
                      handleMapAssetToAmc(amcId, assetId);
                    }} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div className="form-group">
                        <label className="form-label">Select Support Contract</label>
                        <CustomSelect
                          name="amcId"
                          options={amcs.map(amc => ({ value: amc.id, label: `${amc.id} - ${amc.vendor}` }))}
                          value={mapAmcId || amcs[0]?.id || ''}
                          onChange={(e) => setMapAmcId(e.target.value)}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Select Asset to Map</label>
                        <CustomSelect
                          name="assetId"
                          options={assets.filter(a => a.status !== 'Disposed').map(a => ({ value: a.id, label: `${a.id} - ${a.name}` }))}
                          value={mapAssetId || assets.filter(a => a.status !== 'Disposed')[0]?.id || ''}
                          onChange={(e) => setMapAssetId(e.target.value)}
                          required
                        />
                      </div>
                      <SpinnerButton type="submit" className="btn btn-secondary" style={{ marginTop: '8px' }} loading={mappingAmcAsset} loadingText="Linking…">Link Asset</SpinnerButton>
                    </form>
                  ) : (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', padding: '24px' }}>
                      Only Finance and Admins can bind assets to maintenance agreements.
                    </div>
                  )}
                </div>
              </div>

              {/* AMC Contracts List */}
              <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className="card" style={{ marginBottom: '4px' }}>
                  <div className="search-bar-container">
                    <Search className="search-icon" />
                    <input
                      className="search-bar"
                      placeholder="Search contracts by PO number, contract ID or vendor…"
                      value={amcSearch}
                      onChange={(e) => setAmcSearch(e.target.value)}
                    />
                  </div>
                </div>

                {filteredAmcs.length === 0 && (
                  <div className="card">
                    <div className="empty-state">
                      <div className="empty-state-icon"><RefreshCw size={22} /></div>
                      <div className="empty-state-title">No contracts match “{amcSearch}”</div>
                      <div className="empty-state-desc">Try a different PO number, contract ID or vendor name.</div>
                    </div>
                  </div>
                )}

                {filteredAmcs.map(amc => {
                  const isExpiring = (new Date(amc.endDate) - new Date()) < (30 * 24 * 60 * 60 * 1000);
                  return (
                    <div key={amc.id} className="card" style={{ borderLeft: isExpiring ? '4px solid var(--status-disposed)' : '4px solid var(--primary)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <h3 style={{ fontSize: '18px', fontWeight: '700' }}>{amc.vendor}</h3>
                            <span className="badge" style={{ backgroundColor: 'var(--primary-glow)', color: 'var(--primary)' }}>{amc.id}</span>
                            {amc.poNumber && <span className="badge badge-assigned">PO {amc.poNumber}</span>}
                            {isExpiring && <span className="badge badge-disposed">Expiring Soon</span>}
                          </div>
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Agreement: {amc.agreementFile}</span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '20px', fontWeight: '800', color: 'var(--text-primary)' }}>{formatINR(amc.cost)}/year</div>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Interval: {amc.serviceSchedule}</span>
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', backgroundColor: 'var(--bg-app)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '12px' }}>
                        <div>
                          <span style={{ color: 'var(--text-secondary)' }}>Active Period: </span>
                          <strong>{amc.startDate} to {amc.endDate}</strong>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-secondary)' }}>Linked Assets: </span>
                          <strong>{(amc.mappedAssets || []).join(', ') || 'No mapped assets'}</strong>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-secondary)' }}>Last Servicing: </span>
                          <strong>{(amc.serviceHistory || []).length > 0 ? amc.serviceHistory[0].date : 'No records'}</strong>
                        </div>
                      </div>

                      {/* Log service record inside contract */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '20px', marginTop: '10px' }}>
                        <div>
                          <h4 style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Record Maintenance Visit</h4>
                          <form onSubmit={(e) => handleAddAMCServiceRecord(e, amc.id)} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <input type="date" name="date" className="form-input form-input-sm" required />
                              <input type="text" name="type" placeholder="Service action title" className="form-input form-input-sm" style={{ flexGrow: 1}} required />
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <input type="text" name="notes" placeholder="Technician diagnosis summary" className="form-input form-input-sm" style={{ flexGrow: 1}} required />
                              <SpinnerButton type="submit" className="btn btn-secondary btn-sm" loading={addingServiceRecord} loadingText="Saving…">Save Log</SpinnerButton>
                            </div>
                          </form>
                        </div>

                        <div>
                          <h4 style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>Maintenance Service Logs</h4>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '110px', overflowY: 'auto' }}>
                            {amc.serviceHistory.length === 0 ? (
                              <span style={{ fontSize: '11px', fontStyle: 'italic', color: 'var(--text-muted)' }}>No service visits logged yet.</span>
                            ) : (
                              amc.serviceHistory.map((history, idx) => (
                                <div key={idx} style={{ fontSize: '11px', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px' }}>
                                  <span style={{ color: 'var(--primary)', fontWeight: '600' }}>{history.date}</span> - <strong>{history.type}</strong>
                                  <div style={{ color: 'var(--text-secondary)' }}>{history.notes}</div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
  );
}
