import CustomSelect from '../../CustomSelect'
import { AlertTriangle, ArrowLeftRight, Edit2, Eye, FileUp, Package, Plus, QrCode, RefreshCw, Trash2, UserCheck } from 'lucide-react'
import { SpinnerButton } from '../../SpinnerButton'
import { formatINR } from '../../utils/format'
import { useAppData } from '../../context/AppDataContext'

export default function AssetsPage() {
  const { assetFilterCategory, assetFilterDept, assetFilterStatus, assets, bulkAssetCategoryValue, bulkAssetDeptValue, bulkAssetLocationValue, departments, filteredAssets, handleBulkAssetCategoryChange, handleBulkAssetDeptChange, handleBulkAssetLocationChange, handleBulkAssetStatusChange, handleBulkDeleteAssets, handleDeleteAsset, handleDisposeAsset, hasPermission, selectedAssetIds, setAddAssetModal, setAllocateModal, setAssetDetailModal, setAssetFilterCategory, setAssetFilterDept, setAssetFilterStatus, setBulkAssetCategoryValue, setBulkAssetDeptValue, setBulkAssetLocationValue, setEditAssetModal, setQrStickerModal, setReturnModal, setSelectedAssetIds, setShowBulkAssetCategory, setShowBulkAssetDept, setShowBulkAssetLocation, setShowBulkImportAssets, setTransferModal, showBulkAssetCategory, showBulkAssetDept, showBulkAssetLocation, locations } = useAppData();

  return (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Asset Register</span>
                  <h1 className="page-title">Organizational Assets</h1>
                  <span className="page-subtitle">Comprehensive lifecycle register and specifications catalog</span>
                </div>
                <div className="page-actions" style={{ display: 'flex', gap: '8px' }}>
                  {hasPermission('write') && (
                    <>
                      <button className="btn btn-secondary" onClick={() => setShowBulkImportAssets(true)}>
                        <FileUp size={16} />
                        Bulk Import Assets
                      </button>
                      <button className="btn btn-primary" onClick={() => setAddAssetModal(true)}>
                        <Plus size={16} />
                        Register New Asset
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Filters toolbar */}
              <div className="filters-row">
                <div className="filters-left">
                  <span style={{ fontSize: '13px', fontWeight: '600' }}>Filter Category:</span>
                  <CustomSelect
                    options={[
                      { value: "All", label: "All Categories" },
                      { value: "IT", label: "IT Assets" },
                      { value: "Office", label: "Office Infrastructure" }
                    ]}
                    value={assetFilterCategory}
                    onChange={(e) => setAssetFilterCategory(e.target.value)}
                    style={{ width: '160px' }}
                  />

                  <span style={{ fontSize: '13px', fontWeight: '600', marginLeft: '12px' }}>Status:</span>
                  <CustomSelect
                    options={[
                      { value: "All", label: "All Statuses" },
                      { value: "Available", label: "Available" },
                      { value: "Assigned", label: "Assigned" },
                      { value: "Under Maintenance", label: "Under Maintenance" },
                      { value: "Disposed", label: "Disposed" }
                    ]}
                    value={assetFilterStatus}
                    onChange={(e) => setAssetFilterStatus(e.target.value)}
                    style={{ width: '160px' }}
                  />

                  <span style={{ fontSize: '13px', fontWeight: '600', marginLeft: '12px' }}>Department:</span>
                  <CustomSelect
                    // Department options come from the Department Master (via context), the
                    // same source the registration form and bulk pickers use — so adding,
                    // renaming, archiving or deleting a department updates this filter too.
                    options={[
                      { value: "All", label: "All Departments" },
                      ...departments.map((d) => ({ value: d, label: d }))
                    ]}
                    value={assetFilterDept}
                    onChange={(e) => setAssetFilterDept(e.target.value)}
                    style={{ width: '170px' }}
                  />
                </div>

                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Showing {filteredAssets.length} of {assets.length} assets
                </div>
              </div>
              {/* Bulk Asset Action Toolbar */}
              {selectedAssetIds.length > 0 && (
                <div className="card" style={{ padding: '12px 18px', marginBottom: '16px', background: 'rgba(99, 44, 237, 0.1)', border: '1px solid rgba(99, 44, 237, 0.3)', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: '600' }}>
                    {selectedAssetIds.length} asset{selectedAssetIds.length > 1 ? 's' : ''} selected
                  </span>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => handleBulkAssetStatusChange('Available')} loadingText="Working…">Mark Available</SpinnerButton>
                    <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => handleBulkAssetStatusChange('Under Maintenance')} loadingText="Working…">Mark Maintenance</SpinnerButton>
                    <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => handleBulkAssetStatusChange('Disposed')} loadingText="Working…">Mark Disposed</SpinnerButton>
                    
                    {/* Bulk Category */}
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowBulkAssetCategory(!showBulkAssetCategory)}>Category ▾</button>
                      {showBulkAssetCategory && (
                        <div className="card" style={{ position: 'absolute', bottom: '100%', left: 0, zIndex: 10, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', width: '180px', marginBottom: '4px' }}>
                          <CustomSelect 
                            options={['IT', 'Office'].map(c => ({ value: c, label: c + ' Assets' }))} 
                            value={bulkAssetCategoryValue} 
                            onChange={e => setBulkAssetCategoryValue(e.target.value)}
                          />
                          <SpinnerButton className="btn btn-primary btn-sm" onClick={handleBulkAssetCategoryChange} loadingText="Applying…">Apply</SpinnerButton>
                        </div>
                      )}
                    </div>

                    {/* Bulk Location */}
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowBulkAssetLocation(!showBulkAssetLocation)}>Location ▾</button>
                      {showBulkAssetLocation && (
                        <div className="card" style={{ position: 'absolute', bottom: '100%', left: 0, zIndex: 10, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', width: '200px', marginBottom: '4px' }}>
                          <CustomSelect
                            options={locations.map(l => ({ value: l, label: l }))}
                            value={bulkAssetLocationValue}
                            onChange={e => setBulkAssetLocationValue(e.target.value)}
                            searchable
                            placeholder={locations.length ? 'Select location…' : 'No locations available'}
                          />
                          <SpinnerButton className="btn btn-primary btn-sm" onClick={handleBulkAssetLocationChange} loadingText="Applying…">Apply</SpinnerButton>
                        </div>
                      )}
                    </div>

                    {/* Bulk Dept */}
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowBulkAssetDept(!showBulkAssetDept)}>Dept ▾</button>
                      {showBulkAssetDept && (
                        <div className="card" style={{ position: 'absolute', bottom: '100%', left: 0, zIndex: 10, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', width: '180px', marginBottom: '4px' }}>
                          <CustomSelect 
                            options={departments.map(d => ({ value: d, label: d }))} 
                            value={bulkAssetDeptValue} 
                            onChange={e => setBulkAssetDeptValue(e.target.value)}
                          />
                          <SpinnerButton className="btn btn-primary btn-sm" onClick={handleBulkAssetDeptChange} loadingText="Applying…">Apply</SpinnerButton>
                        </div>
                      )}
                    </div>

                    <SpinnerButton className="btn btn-secondary btn-sm" style={{ color: 'var(--status-disposed)'}} onClick={handleBulkDeleteAssets} loadingText="Deleting…">Delete</SpinnerButton>
                  </div>
                </div>
              )}

              {/* Data Table */}
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}>
                        <input 
                          type="checkbox" 
                          checked={filteredAssets.length > 0 && filteredAssets.every(a => selectedAssetIds.includes(a.id))}
                          onChange={() => {
                            const visibleAssetIds = filteredAssets.map(a => a.id);
                            const allSelected = visibleAssetIds.every(id => selectedAssetIds.includes(id));
                            if (allSelected) {
                              setSelectedAssetIds(prev => prev.filter(id => !visibleAssetIds.includes(id)));
                            } else {
                              setSelectedAssetIds(prev => {
                                const added = visibleAssetIds.filter(id => !prev.includes(id));
                                return [...prev, ...added];
                              });
                            }
                          }}
                        />
                      </th>
                      <th>Asset Code</th>
                      <th>Name / Model</th>
                      <th>Category</th>
                      <th>Serial Number</th>
                      <th>Total Qty</th>
                      <th>Available Qty</th>
                      <th>Assigned Qty</th>
                      <th>Location / Dept</th>
                      <th>Price / Cost</th>
                      <th>Assigned To</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAssets.length === 0 ? (
                      <tr>
                        <td colSpan="13">
                          <div className="empty-state">
                            <div className="empty-state-icon"><Package size={22} /></div>
                            <div className="empty-state-title">No assets found</div>
                            <div className="empty-state-desc">
                              Nothing matches your current search and filters. Try clearing them or adding a new asset.
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredAssets.map(asset => (
                        <tr key={asset.id} style={{ cursor: 'pointer' }} onClick={(e) => {
                          if (e.target.type !== 'checkbox' && !e.target.closest('button')) {
                            setAssetDetailModal(asset);
                          }
                        }}>
                          <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                            <input 
                              type="checkbox" 
                              checked={selectedAssetIds.includes(asset.id)}
                              onChange={() => {
                                setSelectedAssetIds(prev => 
                                  prev.includes(asset.id) ? prev.filter(x => x !== asset.id) : [...prev, asset.id]
                                );
                              }}
                            />
                          </td>
                          <td style={{ fontWeight: '700', color: 'var(--primary)' }}>{asset.id}</td>
                          <td>
                            <div className="asset-meta-cell">
                              <div className="asset-image-placeholder">
                                <Package size={18} />
                              </div>
                              <div className="asset-name-meta">
                                <span style={{ fontWeight: '600' }}>{asset.name}</span>
                                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Type: {asset.type}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="badge" style={{ backgroundColor: asset.category === 'IT' ? 'rgba(99, 102, 241, 0.15)' : 'rgba(236, 72, 153, 0.15)', color: asset.category === 'IT' ? 'var(--primary)' : 'var(--secondary)' }}>
                              {asset.category}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: '12px' }}>{asset.serialNumber || '—'}</td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>{asset.totalQuantity !== undefined ? asset.totalQuantity : 1}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-available)' }}>
                            {asset.availableQuantity !== undefined ? asset.availableQuantity : 1}
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-assigned)' }}>
                            {asset.assignedQuantity !== undefined ? asset.assignedQuantity : 0}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span>{asset.location}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Dept: {asset.department}</span>
                            </div>
                          </td>
                          <td style={{ fontWeight: '600', fontFamily: 'var(--font-mono)' }}>
                            {formatINR(asset.cost)}
                          </td>
                          <td style={{ fontWeight: '500' }}>
                            {asset.assignedEmployee ? asset.assignedEmployee : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Unassigned</span>}
                          </td>
                          <td>
                            {(asset.availableQuantity !== undefined ? asset.availableQuantity : 1) === 0 ? (
                              <span className="badge badge-disposed">Out of Stock</span>
                            ) : (
                              <span className={`badge badge-${asset.status.toLowerCase().replace(' ', '-')}`}>
                                {asset.status}
                              </span>
                            )}
                          </td>
                          <td>
                            <div className="table-actions">
                              <button className="btn-table-action" onClick={() => setAssetDetailModal(asset)} title="View Specs & Timeline">
                                <Eye size={15} />
                              </button>
                              {hasPermission('write', asset.category) && (
                                <button className="btn-table-action" onClick={() => setEditAssetModal(asset)} title="Edit Specifications">
                                  <Edit2 size={15} />
                                </button>
                              )}
                              {hasPermission('allocate', asset.category) && (asset.availableQuantity === undefined || asset.availableQuantity > 0) && (
                                <button className="btn-table-action" style={{ color: 'var(--status-assigned)' }} onClick={() => setAllocateModal(asset)} title="Allocate Asset">
                                  <UserCheck size={15} />
                                </button>
                              )}
                              {hasPermission('allocate', asset.category) && asset.assignedQuantity > 0 && (
                                <>
                                  <button className="btn-table-action" style={{ color: 'var(--primary)' }} onClick={() => setTransferModal(asset)} title="Transfer Asset">
                                    <ArrowLeftRight size={15} />
                                  </button>
                                  <button className="btn-table-action" style={{ color: 'var(--status-available)' }} onClick={() => setReturnModal(asset)} title="Record return / deallocate">
                                    <RefreshCw size={15} />
                                  </button>
                                </>
                              )}
                              {hasPermission('write', asset.category) && asset.status !== 'Disposed' && (
                                <SpinnerButton className="btn-table-action" style={{ color: 'var(--status-maintenance)' }} onClick={() => {
                                  const reason = prompt("Enter asset retirement / disposal reason:");
                                  if (reason) return handleDisposeAsset(asset, reason);
                                }} icon={AlertTriangle} spinnerSize={15} title="Mark as Disposed" />
                              )}
                              <button className="btn-table-action" onClick={() => setQrStickerModal(asset)} title="View QR Label sticker">
                                <QrCode size={15} />
                              </button>
                              {hasPermission('delete', asset.category) && (
                                <SpinnerButton className="btn-table-action delete" onClick={() => handleDeleteAsset(asset)} icon={Trash2} spinnerSize={15} title="Delete Asset Record" />
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
  );
}
