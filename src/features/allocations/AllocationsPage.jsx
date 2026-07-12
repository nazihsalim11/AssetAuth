import CustomSelect from '../../CustomSelect'
import EmployeeAssetLookup from '../../EmployeeAssetLookup'
import Modal from '../../Modal'
import { ArrowLeftRight, Edit2, RefreshCw, Search, UserCheck } from 'lucide-react'
import { useAppData } from '../../context/AppDataContext'

export default function AllocationsPage() {
  const { addToast, assets, assignments, movements, quickAllocAssetId, quickTransferAssetId, setAllocateModal, setEditAssignmentModal, setQuickAllocAssetId, setQuickTransferAssetId, setReturnAssignmentModal, setShowEmployeeLookup, setTransferModal, showEmployeeLookup } = useAppData();

  return (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Custody & Allocations</span>
                  <h1 className="page-title">Fleet Allocation & Movements</h1>
                  <span className="page-subtitle">Track custodian assignments, internal branch relocations, and handovers</span>
                </div>
                <div className="page-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowEmployeeLookup(true)}
                  >
                    <Search size={15} /> Employee Asset Lookup
                  </button>
                </div>
              </div>

              {/* A popup rather than an inline panel: the lookup is a reference tool, so
                  it must not push the allocation tables down the page or lose your
                  place when you close it. */}
              <Modal
                isOpen={showEmployeeLookup}
                onClose={() => setShowEmployeeLookup(false)}
                title="Employee Asset Lookup"
                subtitle="Search the directory, then review everything that person holds."
                size="full"
                closeOnOverlayClick
              >
                <EmployeeAssetLookup addToast={addToast} />
              </Modal>

              <div className="dashboard-grid-secondary">
                {/* Allocations Form */}
                <div className="card">
                  <span className="card-title">
                    <ArrowLeftRight size={18} style={{ color: 'var(--primary)' }} />
                    Quick Operations Desk
                  </span>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                      <h4 style={{ fontSize: '14px', marginBottom: '10px' }}>Assign Available Asset</h4>
                      <div className="action-row">
                        <CustomSelect
                          options={[
                            { value: "", label: "-- Select Available Asset --" },
                            ...assets.filter(a => a.status === 'Available').map(a => ({
                              value: a.id,
                              label: `${a.id} - ${a.name} (${a.category})`
                            }))
                          ]}
                          value={quickAllocAssetId}
                          onChange={(e) => setQuickAllocAssetId(e.target.value)}
                          style={{ flexGrow: 1 }}
                        />
                        <button className="btn btn-primary" onClick={() => {
                          const asset = assets.find(a => a.id === quickAllocAssetId);
                          if (asset) {
                            setAllocateModal(asset);
                            setQuickAllocAssetId('');
                          } else {
                            addToast("Selection Error", "Please pick an asset from the list", "warning");
                          }
                        }}>
                          Assign
                        </button>
                      </div>
                    </div>

                    <div>
                      <h4 style={{ fontSize: '14px', marginBottom: '10px' }}>Custodian Handovers & Moves</h4>
                      <div className="action-row">
                        <CustomSelect
                          options={[
                            { value: "", label: "-- Select Assigned Asset --" },
                            ...assets.filter(a => a.assignedQuantity > 0 || a.status === 'Assigned').map(a => ({
                              value: a.id,
                              label: `${a.id} - ${a.name} (Held by: ${a.assignedEmployee || 'Multiple'})`
                            }))
                          ]}
                          value={quickTransferAssetId}
                          onChange={(e) => setQuickTransferAssetId(e.target.value)}
                          style={{ flexGrow: 1 }}
                        />
                        <button className="btn btn-primary" onClick={() => {
                          const asset = assets.find(a => a.id === quickTransferAssetId);
                          if (asset) {
                            setTransferModal(asset);
                            setQuickTransferAssetId('');
                          } else {
                            addToast("Selection Error", "Please select an assigned asset", "warning");
                          }
                        }}>
                          Transfer
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <span className="card-title">
                    <UserCheck size={18} style={{ color: 'var(--status-available)' }} />
                    Active Fleet Statistics
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span>IT Equipment Assigned (Units):</span>
                      <span style={{ fontWeight: '700' }}>
                        {assignments.filter(asg => asg.status === 'Assigned' && (assets.find(a => a.id === asg.assetId)?.category === 'IT')).reduce((acc, c) => acc + c.quantity, 0)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span>Office Infrastructure Assigned (Units):</span>
                      <span style={{ fontWeight: '700' }}>
                        {assignments.filter(asg => asg.status === 'Assigned' && (assets.find(a => a.id === asg.assetId)?.category === 'Office')).reduce((acc, c) => acc + c.quantity, 0)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                      <span>Assets Under Servicing / Repair:</span>
                      <span style={{ fontWeight: '700', color: 'var(--status-maintenance)' }}>{assets.filter(a => a.status === 'Under Maintenance').length}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Active Custodian Assignments Registry */}
              <div className="table-container" style={{ marginTop: '16px' }}>
                <div style={{ padding: '16px 20px', fontWeight: '700', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Active Custodian Assignments Registry</span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Asset Code</th>
                      <th>Asset Name</th>
                      <th>Custodian</th>
                      <th>Qty Assigned</th>
                      <th>Department</th>
                      <th>Assignment Date</th>
                      <th>Notes</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignments.filter(asg => asg.status === 'Assigned').map(asg => (
                      <tr key={asg.id}>
                        <td style={{ fontWeight: '700', color: 'var(--primary)' }}>{asg.assetId}</td>
                        <td>{asg.assetName || assets.find(a => a.id === asg.assetId)?.name || 'Asset'}</td>
                        <td>{asg.employeeName}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{asg.quantity}</td>
                        <td>{asg.department}</td>
                        <td style={{ fontSize: '12px' }}>{new Date(asg.date).toLocaleDateString('en-IN')}</td>
                        <td>{asg.notes}</td>
                        <td>
                          <div className="table-actions">
                            <button className="btn-table-action" style={{ color: 'var(--primary)' }} onClick={() => setEditAssignmentModal(asg)} title="Edit Assignment Specs">
                              <Edit2 size={15} />
                            </button>
                            <button className="btn-table-action" style={{ color: 'var(--status-available)' }} onClick={() => setReturnAssignmentModal(asg)} title="Deallocate / Return">
                              <RefreshCw size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {assignments.filter(asg => asg.status === 'Assigned').length === 0 && (
                      <tr>
                        <td colSpan={8} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>
                          No active custodian assignments registered.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Movements history */}
              <div className="table-container" style={{ marginTop: '16px' }}>
                <div style={{ padding: '16px 20px', fontWeight: '700', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Asset Movement & Custody History Ledger</span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Transaction ID</th>
                      <th>Asset Code</th>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Source Location / Custodian</th>
                      <th>Target Location / Custodian</th>
                      <th>Authorized By</th>
                      <th>Transaction Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map(mvt => (
                      <tr key={mvt.id}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: '11px', fontWeight: '600' }}>{mvt.id}</td>
                        <td style={{ fontWeight: '700', color: 'var(--primary)' }}>{mvt.assetId}</td>
                        <td style={{ fontSize: '12px' }}>{mvt.date}</td>
                        <td>
                          <span className={`badge`} style={{
                            backgroundColor: mvt.type === 'Procurement' ? 'var(--status-available-bg)' : mvt.type === 'Allocation' ? 'var(--status-assigned-bg)' : mvt.type === 'Disposal' ? 'var(--status-disposed-bg)' : 'var(--primary-glow)',
                            color: mvt.type === 'Procurement' ? 'var(--status-available)' : mvt.type === 'Allocation' ? 'var(--status-assigned)' : mvt.type === 'Disposal' ? 'var(--status-disposed)' : 'var(--primary)'
                          }}>
                            {mvt.type}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{mvt.from}</td>
                        <td style={{ fontSize: '12px', fontWeight: '600' }}>{mvt.to}</td>
                        <td style={{ fontSize: '12px' }}>{mvt.actor}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mvt.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
  );
}
