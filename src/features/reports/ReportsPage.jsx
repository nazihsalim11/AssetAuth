import RelativeTime from '../../RelativeTime'
import ReportsCenter from '../../ReportsCenter'
import { Download } from 'lucide-react'
import { formatINR } from '../../utils/format'
import { useAppData } from '../../context/AppDataContext'

export default function ReportsPage() {
  const { addToast, can, generatedReport, handleExportCSV, handleExportExcel, handleExportPDF, logs, reportType, reportsView, setReportType, setReportsView } = useAppData();

  return (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Analytical Reports</span>
                  <h1 className="page-title">Compliance Reports & Audit Logs</h1>
                  <span className="page-subtitle">Extract spreadsheets for audit, or review secure historical system logs</span>
                </div>
              </div>

              {/* Report Center (backend-driven, filterable, exportable) vs the legacy
                  client-side export tables + audit log. */}
              <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-sidebar)', padding: '4px', borderRadius: 'var(--radius-lg)', width: 'fit-content', border: '1px solid var(--border-color)', marginBottom: '20px', flexWrap: 'wrap' }}>
                {[['center', 'Report Center'], ['legacy', 'Quick Exports & Audit Log']].map(([key, label]) => (
                  <button key={key} onClick={() => setReportsView(key)}
                    className={`btn btn-sm ${reportsView === key ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ border: 'none', background: reportsView === key ? undefined : 'transparent' }}>
                    {label}
                  </button>
                ))}
              </div>

              {reportsView === 'center' && (
                <ReportsCenter addToast={addToast} canExport={can('reports', 'export')} />
              )}

              {reportsView === 'legacy' && (
              <>
              {/* Report selector */}
              <div className="tabs-container">
                <button className={`tab-btn ${reportType === 'inventory' ? 'active' : ''}`} onClick={() => setReportType('inventory')}>
                  Asset Inventory
                </button>
                <button className={`tab-btn ${reportType === 'allocation' ? 'active' : ''}`} onClick={() => setReportType('allocation')}>
                  Employee Allocations
                </button>
                <button className={`tab-btn ${reportType === 'amc' ? 'active' : ''}`} onClick={() => setReportType('amc')}>
                  AMC Contracts
                </button>
                <button className={`tab-btn ${reportType === 'invoices' ? 'active' : ''}`} onClick={() => setReportType('invoices')}>
                  Invoices & Taxes
                </button>
                <button className={`tab-btn ${reportType === 'disposal' ? 'active' : ''}`} onClick={() => setReportType('disposal')}>
                  Disposed Assets
                </button>
                <button className={`tab-btn ${reportType === 'movement' ? 'active' : ''}`} onClick={() => setReportType('movement')}>
                  Asset Movement Ledger
                </button>
              </div>

              <div className="page-actions" style={{ justifyContent: 'flex-end', margin: '0', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={handleExportCSV}>
                  <Download size={16} />
                  CSV
                </button>
                <button className="btn btn-secondary" onClick={handleExportExcel}>
                  <Download size={16} />
                  Excel (.xlsx)
                </button>
                <button className="btn btn-secondary" onClick={handleExportPDF}>
                  <Download size={16} />
                  PDF
                </button>
                <button className="btn btn-primary" onClick={() => window.print()}>
                  Print Page
                </button>
              </div>

              {/* Report Render Table */}
              <div className="table-container">
                <table className="data-table">
                  {reportType === 'inventory' && (
                    <>
                      <thead>
                        <tr>
                          <th>Asset ID</th>
                          <th>Name</th>
                          <th>Serial #</th>
                          <th>Cost</th>
                          <th>Purchase Date</th>
                          <th>Warranty End</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: '700' }}>{r.id}</td>
                            <td>{r.name}</td>
                            <td>{r.serialNumber}</td>
                            <td>{formatINR(r.cost)}</td>
                            <td>{r.purchaseDate}</td>
                            <td>{r.warrantyExpiry}</td>
                            <td>{r.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'allocation' && (
                    <>
                      <thead>
                        <tr>
                          <th>Asset ID</th>
                          <th>Name</th>
                          <th>Employee</th>
                          <th>Department</th>
                          <th>Branch Location</th>
                          <th>Warranty Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: '700' }}>{r.id}</td>
                            <td>{r.name}</td>
                            <td style={{ fontWeight: '600' }}>{r.assignedEmployee}</td>
                            <td>{r.department}</td>
                            <td>{r.location}</td>
                            <td>{r.warrantyExpiry}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'amc' && (
                    <>
                      <thead>
                        <tr>
                          <th>Contract ID</th>
                          <th>Vendor Partner</th>
                          <th>Annual Premium</th>
                          <th>SLA Period</th>
                          <th>Frequency</th>
                          <th>Active Fleet Links</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: '700' }}>{r.id}</td>
                            <td>{r.vendor}</td>
                            <td>{formatINR(r.cost)}</td>
                            <td>{r.startDate} to {r.endDate}</td>
                            <td>{r.serviceSchedule}</td>
                            <td>{(r.mappedAssets || []).join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'invoices' && (
                    <>
                      <thead>
                        <tr>
                          <th>Invoice Ref</th>
                          <th>PO Code</th>
                          <th>Vendor Partner</th>
                          <th>Tax (GST %)</th>
                          <th>Base Amount</th>
                          <th>Payment Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: '700' }}>{r.id}</td>
                            <td>{r.poReference}</td>
                            <td>{r.vendor}</td>
                            <td>{r.gst}%</td>
                            <td>{formatINR(r.amount)}</td>
                            <td>{r.paymentStatus}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {reportType === 'disposal' && (
                    <>
                      <thead>
                        <tr>
                          <th>Asset ID</th>
                          <th>Name</th>
                          <th>Serial #</th>
                          <th>Original Cost</th>
                          <th>Disposal Date</th>
                          <th>Disposal Reason / Diagnosis</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.length === 0 ? (
                          <tr>
                            <td colSpan="6" style={{ textAlign: 'center', padding: '16px', color: 'var(--text-secondary)' }}>
                              No disposed assets recorded in ledger.
                            </td>
                          </tr>
                        ) : (
                          generatedReport.map(r => (
                            <tr key={r.id}>
                              <td style={{ fontWeight: '700' }}>{r.id}</td>
                              <td>{r.name}</td>
                              <td>{r.serialNumber}</td>
                              <td>{formatINR(r.cost)}</td>
                              <td>{r.disposalDate}</td>
                              <td>{r.disposalReason}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </>
                  )}

                  {reportType === 'movement' && (
                    <>
                      <thead>
                        <tr>
                          <th>Mvt Ref</th>
                          <th>Asset ID</th>
                          <th>Date</th>
                          <th>Event Action</th>
                          <th>Source Custodian</th>
                          <th>Destination Target</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedReport.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>{r.id}</td>
                            <td style={{ fontWeight: '700' }}>{r.assetId}</td>
                            <td>{r.date}</td>
                            <td>{r.type}</td>
                            <td>{r.from}</td>
                            <td>{r.to}</td>
                            <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{r.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>

              {/* Complete audit trails log entries */}
              <div className="table-container" style={{ marginTop: '24px' }}>
                <div style={{ padding: '16px 20px', fontWeight: '700', borderBottom: '1px solid var(--border-color)' }}>
                  Crypto System Audit Trails Ledger
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Log ID</th>
                      <th>Timestamp</th>
                      <th>Operator Role</th>
                      <th>Action Type</th>
                      <th>Audit Trail Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => (
                      <tr key={log.id}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>{log.id}</td>
                        <td style={{ fontSize: '12px' }}><RelativeTime value={log.createdAt} /></td>
                        <td>
                          <span className="badge" style={{ backgroundColor: 'rgba(99,102,241,0.1)', color: 'var(--primary)' }}>
                            {log.actor}
                          </span>
                        </td>
                        <td style={{ fontWeight: '600' }}>{log.action}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{log.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
              )}
            </>
  );
}
