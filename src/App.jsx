import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { silk } from './engine/motion'
import { openStoredFile } from './files'
import Modal from './Modal'
import {
  LayoutDashboard,
  Package,
  RefreshCw,
  UserCheck,
  FileText,
  FolderOpen,
  QrCode,
  ClipboardList, BookOpen,
  ShieldCheck,
  Bell,
  Search,
  Plus,
  Eye,
  Edit2,
  Trash2,
  ArrowLeftRight,
  AlertTriangle,
  X,
  Download,
  FileUp,
  Mail,
  Sun,
  Moon,
  LogOut,
  Users,
  Menu
} from 'lucide-react'
import { mockAuthService } from './auth'
import LoginView from './LoginView'
import CustomSelect from './CustomSelect'
import RelativeTime from './RelativeTime'
import { can as canPerm, canLegacy, roleLabel } from './permissions'
import AsyncBoundary from './AsyncBoundary'
import { STATUS } from './asyncStatus'
import { PageSkeleton } from './Skeleton'
import { SpinnerButton } from './SpinnerButton'
import { useAsyncAction } from './useAsyncAction'
import { useAnchoredOverlay } from './useAnchoredOverlay'
import { useDismissableLayer } from './useDismissableLayer'
import { lockBodyScroll, unlockBodyScroll } from './scrollLock'
import { api } from './api'
import BulkImportModal from './BulkImportModal'
import DashboardPage from './features/dashboard/DashboardPage'
import { AppDataProvider } from './context/AppDataContext'
import { formatINR } from './utils/format'

// Route-level page components are code-split: each loads as its own chunk the first
// time its tab is opened, keeping them out of the initial bundle. They render inside
// the <Suspense> boundary in the page container below. DashboardPage is eager (imported
// above) because it is the default landing view.
const KnowledgeBasePage = lazy(() => import('./KnowledgeBasePage'))
const EmailInboxModule = lazy(() => import('./EmailInboxModule'))
const PurchaseOrdersPage = lazy(() => import('./PurchaseOrdersPage'))
const EmployeeAssetLookup = lazy(() => import('./EmployeeAssetLookup'))
const TicketsPage = lazy(() => import('./TicketsPage'))
const SlaManagementPage = lazy(() => import('./SlaManagementPage'))
const ReportsCenter = lazy(() => import('./ReportsCenter'))
const QRCodeSticker = lazy(() => import('./features/assets/QRCodeSticker'))
const UserManagementPage = lazy(() => import('./features/users/UserManagementPage'))
const QrLookupPage = lazy(() => import('./features/qrLookup/QrLookupPage'))
const AssetsPage = lazy(() => import('./features/assets/AssetsPage'))
const AllocationsPage = lazy(() => import('./features/allocations/AllocationsPage'))
const AmcPage = lazy(() => import('./features/amc/AmcPage'))
const ReportsPage = lazy(() => import('./features/reports/ReportsPage'))
const DocumentsPage = lazy(() => import('./features/documents/DocumentsPage'))
import { clearCachedUserData } from './utils/cache'
import { VALID_TABS } from './constants/tabs'
import './App.css'


// UserManagementPage + UserDirectoryPage now live in ./features/users.

// Purge any legacy cache the moment the module loads, before the UI renders.
// (LEGACY_CACHE_KEYS + clearCachedUserData now live in ./utils/cache.)
clearCachedUserData();


// VALID_TABS (the hash routes an authenticated user can land on) now lives in
// ./constants/tabs.

function App() {
  // Navigation & Auth States
  const [currentUser, setCurrentUser] = useState(() => mockAuthService.getCurrentSession());
  const [activeTab, setActiveTab] = useState(() => {
    const session = mockAuthService.getCurrentSession();
    if (!session) return 'login';
    const hash = window.location.hash.replace('#/', '');
    return hash && VALID_TABS.includes(hash) ? hash : 'dashboard';
  });
  const [currentRole, setCurrentRole] = useState(() => {
    const session = mockAuthService.getCurrentSession();
    return session ? session.role : 'Super Admin';
  });
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('app-theme') || 'light';
  });

  // DB States (Loaded from Local Storage)
  const [assets, setAssets] = useState([]);
  const [amcs, setAmcs] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState([]);
  const [invoiceSearchTerm, setInvoiceSearchTerm] = useState('');
  const [invoicePdfSearchTerm, setInvoicePdfSearchTerm] = useState('');
  const [showBulkImportInvoices, setShowBulkImportInvoices] = useState(false);
  const [financeSubTab, setFinanceSubTab] = useState('all');
  const [invoiceFilterStatus, setInvoiceFilterStatus] = useState('All');
  const [invoiceSortField, setInvoiceSortField] = useState('id');
  const [invoiceSortOrder, setInvoiceSortOrder] = useState('desc');
  const [invoiceCurrentPage, setInvoiceCurrentPage] = useState(1);
  const [invoiceItemsPerPage] = useState(10);
  const [documents, setDocuments] = useState([]);
  const [movements, setMovements] = useState([]);
  const [logs, setLogs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [emails, setEmails] = useState([]);
  const [selectedEmailId, setSelectedEmailId] = useState(() => emails[0]?.id || null);
  const [usersList, setUsersList] = useState([]);
  // The authoritative matrix is fetched from /api/role-permissions on load; these
  // defaults (identical to the DB seed) only gate the UI during that first request.
  const [rolePermissions, setRolePermissions] = useState({});
  // The permission vocabulary (modules, verbs, role labels) shipped by the API.
  const [permModel, setPermModel] = useState({ modules: [], roles: [], verbLabels: {} });
  const [assignments, setAssignments] = useState([]);
  const [departments, setDepartments] = useState(['IT', 'HR', 'Finance', 'Operations', 'Administration']);

  const [quickAllocAssetId, setQuickAllocAssetId] = useState('');
  const [quickTransferAssetId, setQuickTransferAssetId] = useState('');

  // Controlled states for AMC forms
  const [newAmcServiceSchedule, setNewAmcServiceSchedule] = useState('Monthly');
  const [mapAmcId, setMapAmcId] = useState('');
  const [mapAssetId, setMapAssetId] = useState('');
  const [newDocCategory, setNewDocCategory] = useState('Invoice');

  // Controlled states for Modal selectors
  const [addAssetCategory, setAddAssetCategory] = useState('IT');
  const [addAssetType, setAddAssetType] = useState('');
  const [addAssetInvoiceId, setAddAssetInvoiceId] = useState('');
  const [editAssetInvoiceId, setEditAssetInvoiceId] = useState('');
  const [editAssetType, setEditAssetType] = useState('');
  // Master data: { IT: [...subtypes], Office: [...subtypes] }. Loaded from the
  // server so the Item Type dropdowns are data-driven, not hard-coded.
  const [assetSubtypes, setAssetSubtypes] = useState({});
  const [allocateEmployee, setAllocateEmployee] = useState('');
  const [allocateDepartment, setAllocateDepartment] = useState('');
  const [isAllocating, setIsAllocating] = useState(false);
  const [transferTargetType, setTransferTargetType] = useState('employee');
  const [transferEmployee, setTransferEmployee] = useState('');
  const [transferDepartment, setTransferDepartment] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [showEmployeeLookup, setShowEmployeeLookup] = useState(false);
  const [amcSearch, setAmcSearch] = useState('');
  const [selectedNotificationIds, setSelectedNotificationIds] = useState([]);
  const [isDeletingNotifications, setIsDeletingNotifications] = useState(false);

  // Drop selections whose notification no longer exists, so a stale id can never be
  // sent in a bulk delete after a refresh.
  React.useEffect(() => {
    setSelectedNotificationIds(prev => {
      const live = new Set(notifications.map(n => n.id));
      const next = prev.filter(id => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [notifications]);

  const [isApiConnected, setIsApiConnected] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  // A failed load must not look like an empty database. Hold the error so the page
  // can say "we could not ask" rather than rendering 0 assets and "No data".
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const retryInitialLoad = React.useCallback(() => {
    setLoadError(null);
    setReloadToken((t) => t + 1);
  }, []);

  const dataStatus = isInitialLoading
    ? STATUS.LOADING
    : loadError
      ? STATUS.ERROR
      : STATUS.READY;

  // Reload live data from PostgreSQL whenever the authenticated identity changes.
  //
  // Keying on the user id is the security fix: this effect used to run once at mount,
  // but logging out and back in as a different user never remounts <App>, so the
  // previous user's assets stayed in state (and in localStorage) until a manual page
  // refresh. An admin's full asset list would linger for the employee who logged in
  // next. Re-running per identity means the server — which scopes every response to
  // the caller's token — repopulates state for the new user immediately.
  //
  // authKey folds login and logout into one trigger: a real id when signed in, null
  // when signed out.
  const authKey = currentUser ? (currentUser.id ?? currentUser.username ?? 'session') : null;

  useEffect(() => {
    // Ignore a response that arrives after the identity changed again (fast
    // logout/login), so a stale in-flight load can never overwrite the current user.
    let cancelled = false;

    // Signed out: hold nothing role-scoped in memory or in the cache.
    if (!authKey) {
      clearCachedUserData();
      setAssets([]); setAmcs([]); setInvoices([]); setDocuments([]);
      setMovements([]); setLogs([]); setNotifications([]); setEmails([]);
      setAssignments([]); setUsersList([]);
      setIsInitialLoading(false);
      return () => { cancelled = true; };
    }

    setIsInitialLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const connected = await api.checkConnection();
        if (cancelled) return;
        if (connected) {
          console.log('[AssetFlow] Loading live data for the current session...');
          // getDocuments 403s for roles without viewDocuments (enforced server-side),
          // so it is made resilient here — an unauthorised repository yields [] rather
          // than failing the whole batch.
          const [dbAssets, dbAmcs, dbInvoices, dbDocuments, dbMovements, dbLogs, dbNotifications, dbEmails, dbUsers, dbAssignments, dbRolePerms, dbDepartments, dbAssetSubtypes] = await Promise.all([
            api.getAssets(),
            api.getAmcs(),
            api.getInvoices(),
            api.getDocuments().catch(() => []),
            api.getMovements(),
            api.getLogs(),
            api.getNotifications(),
            api.getEmails(),
            api.getUsers(),
            api.getAssignments(),
            api.getRolePermissions(),
            api.getDepartments().catch(() => null),
            api.getAssetSubtypes().catch(() => ({}))
          ]);
          if (cancelled) return;
          if (dbRolePerms && typeof dbRolePerms === 'object') {
            // The API now returns { modules, roles, verbLabels, matrix }; older
            // shapes (a bare matrix) are tolerated so a stale server still works.
            const matrix = dbRolePerms.matrix || dbRolePerms;
            setRolePermissions(matrix);
            if (dbRolePerms.modules) {
              setPermModel({
                modules: dbRolePerms.modules,
                roles: dbRolePerms.roles || [],
                verbLabels: dbRolePerms.verbLabels || {}
              });
            }
          }
          if (Array.isArray(dbDepartments) && dbDepartments.length) setDepartments(dbDepartments);
          if (dbAssetSubtypes && typeof dbAssetSubtypes === 'object') setAssetSubtypes(dbAssetSubtypes);

          // Promise.all above rejects if any fetch fails, so reaching this point
          // means every response is authoritative — including an empty one. Always
          // take the server's answer; it is already scoped to this user's role.
          const assetsList = dbAssets || [];
          setAssets(assetsList);

          setAmcs((dbAmcs || []).map(amc => ({
            ...amc,
            mappedAssets: assetsList.filter(a => a.amcId === amc.id).map(a => a.id),
            serviceHistory: amc.serviceHistory || []
          })));

          setInvoices((dbInvoices || []).map(inv => ({
            ...inv,
            mappedAssets: assetsList.filter(a => a.invoiceId === inv.id).map(a => a.id)
          })));

          setDocuments(dbDocuments || []);
          setMovements(dbMovements || []);
          setLogs(dbLogs || []);
          setNotifications(dbNotifications || []);
          setEmails(dbEmails || []);
          setUsersList(dbUsers || []);
          setAssignments(dbAssignments || []);

          setIsApiConnected(true);
        } else {
          // There is no local fallback any more. Saying nothing here left every
          // page rendering zeros against empty arrays, which reads as real data.
          setIsApiConnected(false);
          setLoadError(new Error('Unable to reach the server. It may be starting up, or temporarily unavailable.'));
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[AssetFlow] Initial data load failed:', err);
          setIsApiConnected(false);
          setLoadError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) setIsInitialLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey, reloadToken]);

  // Re-reads the custodian registry from the server. The backend inner-joins assets
  // and users, so whatever it returns is guaranteed to reference records that still
  // exist. Prefer this over locally filtering assignments after a delete: the local
  // filters matched on employee *name*, which silently missed renamed or duplicate
  // custodians and left orphans behind in state (and in localStorage).
  const refreshAssignments = React.useCallback(async () => {
    if (!isApiConnected) return null;
    try {
      const fresh = await api.getAssignments();
      setAssignments(fresh || []);
      return fresh || [];
    } catch (err) {
      console.warn('[AssetFlow] Could not refresh custodian assignments:', err);
      return null;
    }
  }, [isApiConnected]);

  // Called after users are removed. Online, the database has already cascaded the
  // assignments away, so we just resync. Offline there is no server to ask, so drop
  // them by user_id (falling back to name only for legacy rows that predate user_id).
  const handleUsersDeleted = React.useCallback(async (deletedUsers = []) => {
    const refreshed = await refreshAssignments();
    if (refreshed) return;

    const deletedIds = new Set(deletedUsers.map(u => u.id).filter(id => id != null));
    const deletedNames = new Set(
      deletedUsers.flatMap(u => [u.name, u.username]).filter(Boolean)
    );
    setAssignments(prev => prev.filter(asg => {
      if (asg.userId != null) return !deletedIds.has(asg.userId);
      return !deletedNames.has(asg.employeeName);
    }));
  }, [refreshAssignments]);

  const [mappingInvoiceId, setMappingInvoiceId] = useState('');

  // Sync Asset Picker state when selected invoice changes
  useEffect(() => {
    if (mappingInvoiceId) {
      const currentlyMapped = assets.filter(a => a.invoiceId === mappingInvoiceId).map(a => a.id);
      setSelectedMappingAssets(currentlyMapped);
    } else {
      setSelectedMappingAssets([]);
    }
  }, [mappingInvoiceId, assets]);

  // Modals & UI States
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notifBellRef = useRef(null);
  const notifPopoverRef = useRef(null);
  const notifPopoverStyle = useAnchoredOverlay(notifBellRef, showNotifications, {
    width: 340,
    align: 'end',
    gap: 10,
    maxHeight: 480
  });
  // Close the popover on outside click / Escape, and dismiss it whenever another
  // overlay (a dropdown, the bulk-action menu, …) opens. The bell itself is an
  // anchor so clicking it to toggle closed is left to its own handler.
  const closeNotifications = useCallback(() => setShowNotifications(false), []);
  useDismissableLayer(showNotifications, closeNotifications, [notifBellRef, notifPopoverRef]);
  const [toasts, setToasts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modals Data States
  const [assetDetailModal, setAssetDetailModal] = useState(null);
  const [invoiceDetailModal, setInvoiceDetailModal] = useState(null);
  const [mappingAssetSearch, setMappingAssetSearch] = useState('');
  const [mappingAssetCategory, setMappingAssetCategory] = useState('All');
  const [selectedMappingAssets, setSelectedMappingAssets] = useState([]);
  const [qrStickerModal, setQrStickerModal] = useState(null);
  const [addAssetModal, setAddAssetModal] = useState(false);
  const [editAssetModal, setEditAssetModal] = useState(null);
  const [allocateModal, setAllocateModal] = useState(null);
  const [transferModal, setTransferModal] = useState(null);

  // Every custodian picker draws from the live user directory. The selectors used to
  // hold a hardcoded list (Bob Smith, Charlie Brown, Diana Prince) of people who do
  // not exist in the database, which is how assets were handed to phantom custodians.
  const activeEmployees = React.useMemo(
    () => (usersList || [])
      .filter(u => u && u.name && (u.status || 'Active') === 'Active')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [usersList]
  );

  const employeeOptions = React.useMemo(
    () => activeEmployees.map(u => ({
      value: u.name,
      label: `${u.name}${u.department ? ` (${u.department})` : ''}${u.employeeId ? ` — ${u.employeeId}` : ''}`
    })),
    [activeEmployees]
  );

  // PO Number is the contract's business identifier, so it is searchable alongside
  // the contract ID and vendor.
  const filteredAmcs = React.useMemo(() => {
    const term = amcSearch.trim().toLowerCase();
    if (!term) return amcs;
    return amcs.filter(a =>
      String(a.poNumber || '').toLowerCase().includes(term) ||
      String(a.id || '').toLowerCase().includes(term) ||
      String(a.vendor || '').toLowerCase().includes(term)
    );
  }, [amcs, amcSearch]);

  const findEmployeeByName = React.useCallback(
    (name) => activeEmployees.find(u => u.name === name) || null,
    [activeEmployees]
  );

  // Seed the relocation form from the asset each time the modal opens, so a previous
  // transfer's custodian/department never leaks into the next one.
  React.useEffect(() => {
    if (transferModal) {
      setTransferTargetType('employee');
      setTransferEmployee('');
      setTransferDepartment(transferModal.department || '');
    }
  }, [transferModal]);

  // Reset the allocation form each time the modal opens, so a previous allocation's
  // custodian and department cannot linger. Department starts empty until an employee
  // is chosen; selecting one fills it from that employee's own department.
  React.useEffect(() => {
    if (allocateModal) {
      setAllocateEmployee('');
      setAllocateDepartment('');
    }
  }, [allocateModal]);
  const [returnModal, setReturnModal] = useState(null);
  const [showBulkImportEmployees, setShowBulkImportEmployees] = useState(false);
  const [showBulkImportAssets, setShowBulkImportAssets] = useState(false);
  const [editAssignmentModal, setEditAssignmentModal] = useState(null);
  const [returnAssignmentModal, setReturnAssignmentModal] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Sync controlled editAssetInvoiceId / editAssetType state when Edit Asset Modal opens
  useEffect(() => {
    if (editAssetModal) {
      setEditAssetInvoiceId(editAssetModal.invoiceId || '');
      setEditAssetType(editAssetModal.type || '');
    }
  }, [editAssetModal]);
  
  // Scanners / Filters
  const [scannerSelectedAssetId, setScannerSelectedAssetId] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isWebcamScanning, setIsWebcamScanning] = useState(false);

  useEffect(() => {
    let scanner = null;
    let cancelled = false;
    if (isWebcamScanning) {
      // html5-qrcode is a large dependency and only the webcam scanner needs it, so it
      // is loaded on demand the moment the camera view opens.
      import('html5-qrcode').then(({ Html5QrcodeScanner }) => {
        if (cancelled) return;
        setTimeout(() => {
          if (cancelled) return;
          const element = document.getElementById("reader");
          if (element) {
            scanner = new Html5QrcodeScanner("reader", {
              fps: 10,
              qrbox: { width: 250, height: 250 },
              aspectRatio: 1.0
            }, false);

            scanner.render((decodedText) => {
              setIsWebcamScanning(false);
              scanner.clear().catch(err => console.error("Failed to clear scanner:", err));

              const assetId = decodedText.trim();
              const asset = assets.find(a => a.id === assetId || assetId.includes(a.id));
              if (asset) {
                setAssetDetailModal(asset);
                addToast("QR Code Scanned", `Asset lookup found: ${asset.id}`, "success");
              } else {
                addToast("Not Found", `No asset matches: "${assetId}"`, "error");
              }
            }, () => {
              // Frame scan failure - ignore
            });
          }
        }, 300);
      });
    }

    return () => {
      cancelled = true;
      if (scanner) {
        scanner.clear().catch(err => console.log("Failed to clear scanner on unmount:", err));
      }
    };
  }, [isWebcamScanning, assets]);
  const [assetFilterCategory, setAssetFilterCategory] = useState('All');
  const [assetFilterStatus, setAssetFilterStatus] = useState('All');
  const [assetFilterDept, setAssetFilterDept] = useState('All');

  // Asset Selection and Bulk Action States
  const [selectedAssetIds, setSelectedAssetIds] = useState([]);
  const [bulkAssetCategoryValue, setBulkAssetCategoryValue] = useState('IT');
  const [showBulkAssetCategory, setShowBulkAssetCategory] = useState(false);
  const [bulkAssetLocationValue, setBulkAssetLocationValue] = useState('New York HQ');
  const [showBulkAssetLocation, setShowBulkAssetLocation] = useState(false);
  const [bulkAssetDeptValue, setBulkAssetDeptValue] = useState('IT');
  const [showBulkAssetDept, setShowBulkAssetDept] = useState(false);

  useEffect(() => {
    setSelectedAssetIds([]);
    setSelectedInvoiceIds([]);
    setInvoiceCurrentPage(1);
    setInvoiceFilterStatus('All');
    setInvoiceSearchTerm('');
  }, [activeTab, assetFilterCategory, assetFilterStatus, assetFilterDept]);

  const [reportType, setReportType] = useState('inventory');
  // Reports tab: the new backend-driven Report Center vs the legacy quick-export tables.
  const [reportsView, setReportsView] = useState('center');
  const [generatedReport, setGeneratedReport] = useState([]);

  // First-Login Password Flow states and handler
  const [firstLoginPassword, setFirstLoginPassword] = useState('');
  const [firstLoginConfirm, setFirstLoginConfirm] = useState('');
  const [firstLoginError, setFirstLoginError] = useState('');
  const [firstLoginSuccess, setFirstLoginSuccess] = useState('');
  const [firstLoginLoading, setFirstLoginLoading] = useState(false);

  const handleFirstLoginPasswordReset = async (e) => {
    e.preventDefault();
    setFirstLoginError('');
    setFirstLoginSuccess('');

    if (firstLoginPassword.length < 8) {
      setFirstLoginError('Password must be at least 8 characters long.');
      return;
    }
    if (firstLoginPassword !== firstLoginConfirm) {
      setFirstLoginError('Passwords do not match.');
      return;
    }

    setFirstLoginLoading(true);
    try {
      if (isApiConnected) {
        await api.changePassword(currentUser.username, null, firstLoginPassword);
      }
      
      const updatedUser = { ...currentUser, passwordResetRequired: false };
      setCurrentUser(updatedUser);
      
      const storage = localStorage.getItem('user_session') ? localStorage : sessionStorage;
      storage.setItem('user_session', JSON.stringify(updatedUser));

      setUsersList(prev => prev.map(u => u.username === currentUser.username ? { ...u, password_reset_required: false } : u));
      setFirstLoginSuccess('Password updated successfully! Redirecting...');
    } catch (err) {
      setFirstLoginError(err.message || 'Failed to change password.');
    } finally {
      setFirstLoginLoading(false);
    }
  };

  // Business data is no longer mirrored to localStorage. The database is the single
  // source of truth: state is populated from the API on load and every mutation is
  // written through, so nothing sensitive lingers in the browser.

  // Apply Theme class to Body
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'light') {
      root.classList.add('light-theme');
    } else {
      root.classList.remove('light-theme');
    }
    localStorage.setItem('app-theme', theme);
  }, [theme]);

  // Handle hash change routing & route protection
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#/', '');

      const session = mockAuthService.getCurrentSession();
      if (!session) {
        if (window.location.hash !== '#/login') {
          window.location.hash = '#/login';
        }
        setActiveTab('login');
      } else {
        if (hash === 'login' || !hash) {
          window.location.hash = '#/dashboard';
          setActiveTab('dashboard');
        } else if (VALID_TABS.includes(hash)) {
          setActiveTab(hash);
        }
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();

    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [currentUser]);

  // Synchronize role state with currentUser session details
  useEffect(() => {
    if (currentUser) {
      setCurrentRole(currentUser.role);
    }
  }, [currentUser]);

  // Handle Logout
  const handleLogout = () => {
    mockAuthService.logout();
    setCurrentUser(null);
    setCurrentRole('Super Admin');
    window.location.hash = '#/login';
    setActiveTab('login');
    addToast("Logged Out", "You have successfully signed out.", "info");
  };

  // The JWT expires after 24h but the stored session does not, so the app can look
  // signed in while every authenticated call 401s. api.js raises this on such a
  // response; drop the dead session and send the user back to login with a reason.
  useEffect(() => {
    const onSessionExpired = (e) => {
      const expired = e.detail?.code === 'TOKEN_EXPIRED';
      mockAuthService.logout();
      setCurrentUser(null);
      setCurrentRole('Super Admin');
      window.location.hash = '#/login';
      setActiveTab('login');
      addToast(
        expired ? "Session expired" : "Sign-in required",
        expired
          ? "Your session timed out. Please sign in again to continue."
          : "Please sign in again to continue.",
        "warning"
      );
    };
    window.addEventListener('assetflow:session-expired', onSessionExpired);
    return () => window.removeEventListener('assetflow:session-expired', onSessionExpired);
  }, []);

  const navigate = (tab) => {
    window.location.hash = `#/${tab}`;
    setMobileNavOpen(false);
  };

  // While the nav drawer is open it behaves like a dialog: the page behind it does
  // not scroll, Escape dismisses it, and growing past the phone breakpoint closes it
  // so the drawer can never be left open over a layout that already shows the rail.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;

    lockBodyScroll();
    const onKeyDown = (e) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    const desktop = window.matchMedia('(min-width: 641px)');
    const onBreakpoint = (e) => { if (e.matches) setMobileNavOpen(false); };

    document.addEventListener('keydown', onKeyDown);
    desktop.addEventListener('change', onBreakpoint);
    return () => {
      unlockBodyScroll();
      document.removeEventListener('keydown', onKeyDown);
      desktop.removeEventListener('change', onBreakpoint);
    };
  }, [mobileNavOpen]);

  // Toast triggers helper
  const addToast = (title, message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, title, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Add Log Entry helper
  const addAuditLog = async (action, detail) => {
    const newLog = {
      id: `LOG-${Date.now()}`,
      // An instant, not a pre-rendered locale string: the UI formats it, and the
      // server's own created_at replaces this on the next fetch.
      createdAt: new Date().toISOString(),
      actor: currentRole,
      action,
      detail
    };
    setLogs(prev => [newLog, ...prev]);
    if (isApiConnected) {
      try {
        await api.createLog(newLog);
      } catch (err) {
        console.error("Failed to save audit log to DB:", err);
      }
    }
  };

  // Role Permissions Helper — reads from the live `rolePermissions` config
  // Granular gate against the module -> verb matrix. Use this for new code and for
  // gating menus, pages and buttons. Mirrors backend permissionModel.can.
  const can = (moduleKey, verb) => canPerm(rolePermissions, currentRole, moduleKey, verb);

  // Which permission module the current page belongs to (null = ungated page like
  // the profile). Used to block direct hash navigation to a module the role cannot
  // view, not just to hide its nav item.
  const NAV_TO_MODULE = {
    dashboard: 'dashboard', assets: 'assets', allocations: 'allocations', amc: 'amc',
    finance: 'finance', documents: 'documents', qr_lookup: 'qr', reports: 'reports',
    emails: 'emails', tickets: 'tickets', sla: 'sla', knowledge_base: 'knowledge', users: 'userDirectory'
  };
  const activeModule = NAV_TO_MODULE[activeTab] || null;
  const activePageDenied = activeModule && !can(activeModule, 'view');

  // Legacy shim: the many existing hasPermission('write' | 'viewDocuments' | ...) call
  // sites resolve through the matrix via the flat-key map, so they keep working while
  // the app migrates to can(). Asset-category scoping is preserved (a Pass-2 item to
  // move into the data layer rather than a role string).
  const hasPermission = (action, assetCategory = null) => {
    if (currentRole === 'Super Admin') return true;
    if (currentRole === 'IT Admin' && assetCategory && assetCategory !== 'IT') return false;
    if (currentRole === 'Facility Admin' && assetCategory && assetCategory !== 'Office') return false;
    return canLegacy(rolePermissions, currentRole, action);
  };

  // Warranty and AMC expiry alerts are generated server-side by the notification
  // scheduler (backend/notifications/scheduler.js, driven by cron): one persisted,
  // per-user, de-duplicated notification per asset/contract. A second client-side
  // pass here produced a parallel, unpersisted copy of each — the same alert twice
  // in the bell feed — so it has been removed. See getNotifications on load.

  // Handle asset addition
  const [handleAddAsset, addingAsset] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const category = data.get('category');
    
    if (!hasPermission('write', category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to register ${category} assets.`, "error");
      return;
    }

    const qty = parseInt(data.get('quantity') || 1);
    const cost = parseFloat(data.get('cost') || 0);
    const newAsset = {
      id: data.get('id') || `AST-${String(assets.length + 1).padStart(3, '0')}`,
      name: data.get('name'),
      serialNumber: data.get('serialNumber') || null,
      category,
      type: data.get('type'),
      status: "Available",
      cost,
      purchaseDate: data.get('purchaseDate') || new Date().toISOString().split('T')[0],
      warrantyExpiry: data.get('warrantyExpiry'),
      department: data.get('department'),
      associateDepartment: data.get('associateDepartment') || '',
      location: data.get('location'),
      amcId: "",
      invoiceId: data.get('invoiceId') || "",
      assignedEmployee: "",
      // Useful Lifespan is optional — a blank field stays null rather than defaulting.
      depreciationLifeYears: data.get('depreciationLifeYears') ? parseInt(data.get('depreciationLifeYears')) : null,
      disposalDate: "",
      disposalReason: "",
      notes: data.get('notes'),
      totalQuantity: qty,
      availableQuantity: qty,
      assignedQuantity: 0,
      brand: data.get('brand') || '',
      model: data.get('model') || '',
      unit: data.get('unit') || 'pcs',
      supplier: data.get('supplier') || ''
    };

    if (isApiConnected) {
      try {
        await api.createAsset(newAsset);
      } catch {
        addToast("Database Error", "Failed to save asset to PostgreSQL.", "error");
        return;
      }
    }

    // Update list
    setAssets(prev => [newAsset, ...prev]);
    // Log movement
    const newMvt = {
      id: `MVT-${Date.now()}`,
      assetId: newAsset.id,
      date: newAsset.purchaseDate,
      type: "Procurement",
      from: "Vendor",
      to: `Inventory (${newAsset.location})`,
      actor: currentRole,
      notes: `Asset registered. ${newAsset.notes}`
    };
    setMovements(prev => [newMvt, ...prev]);
    if (isApiConnected) {
      try {
        await api.createMovement(newMvt);
      } catch (err) {
        console.error("Failed to log movement to database:", err);
      }
    }
    await addAuditLog("Asset Registration", `Registered asset ${newAsset.id} (${newAsset.name})`);
    addToast("Asset Registered", `${newAsset.id} added successfully to inventory.`, "success");
    setAddAssetModal(false);
    setAddAssetCategory('IT');
    setAddAssetType('');
    setAddAssetInvoiceId('');
  });

  // Handle asset edit
  const [handleEditAsset, editingAsset] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const id = editAssetModal.id;
    const category = editAssetModal.category;

    if (!hasPermission('write', category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to edit ${category} assets.`, "error");
      return;
    }

    const totalQty = parseInt(data.get('totalQuantity') || editAssetModal.totalQuantity || 1);
    const assignedQty = editAssetModal.assignedQuantity || 0;

    if (totalQty < assignedQty) {
      addToast("Validation Error", `Total quantity (${totalQty}) cannot be less than already assigned quantity (${assignedQty}).`, "error");
      return;
    }

    const availableQty = totalQty - assignedQty;

    const updatedFields = {
      name: data.get('name'),
      serialNumber: data.get('serialNumber') || null,
      type: data.get('type'),
      cost: parseFloat(data.get('cost') || 0),
      purchaseDate: data.get('purchaseDate'),
      warrantyExpiry: data.get('warrantyExpiry'),
      location: data.get('location'),
      department: data.get('department'),
      associateDepartment: data.get('associateDepartment') || '',
      invoiceId: data.get('invoiceId'),
      // Useful Lifespan is optional — a blank field stays null rather than defaulting.
      depreciationLifeYears: data.get('depreciationLifeYears') ? parseInt(data.get('depreciationLifeYears')) : null,
      notes: data.get('notes'),
      totalQuantity: totalQty,
      availableQuantity: availableQty,
      brand: data.get('brand') || '',
      model: data.get('model') || '',
      unit: data.get('unit') || 'pcs',
      supplier: data.get('supplier') || ''
    };

    if (isApiConnected) {
      try {
        await api.updateAsset(id, updatedFields);
      } catch {
        addToast("Database Error", "Failed to update asset in PostgreSQL.", "error");
        return;
      }
    }

    setAssets(prev => prev.map(asset => {
      if (asset.id === id) {
        return {
          ...asset,
          ...updatedFields
        };
      }
      return asset;
    }));

    await addAuditLog("Asset Edit", `Updated asset details for ${id}`);
    addToast("Asset Updated", `Asset ${id} details updated.`, "success");
    setEditAssetModal(null);
  });

  // Handle asset deletion
  const handleDeleteAsset = async (asset) => {
    if (!hasPermission('delete', asset.category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to delete ${asset.category} assets.`, "error");
      return;
    }

    if (window.confirm(`Are you sure you want to delete asset ${asset.id} (${asset.name}) permanently?`)) {
      if (isApiConnected) {
        try {
          await api.deleteAsset(asset.id);
        } catch {
          addToast("Database Error", "Failed to delete asset from PostgreSQL.", "error");
          return;
        }
      }
      setAssets(prev => prev.filter(a => a.id !== asset.id));
      // The asset's assignments are cascaded away in the database. Resync so the
      // registry reflects that; the local filter is only the offline fallback.
      if (!(await refreshAssignments())) {
        setAssignments(prev => prev.filter(asg => asg.assetId !== asset.id));
      }
      await addAuditLog("Asset Deletion", `Deleted asset ${asset.id}`);
      addToast("Asset Deleted", `Asset ${asset.id} removed from system.`, "success");
      
      // Close detail view if open
      if (assetDetailModal && assetDetailModal.id === asset.id) {
        setAssetDetailModal(null);
      }
    }
  };

  // Handle asset allocation
  const handleAllocate = async (e) => {
    e.preventDefault();
    // Re-entry guard: a second submit (double click, Enter while the first is in
    // flight) would create a duplicate assignment. Bail before any work runs.
    if (isAllocating) return;
    const data = new FormData(e.target);
    const assetId = allocateModal.id;
    const employee = data.get('employee');
    const dept = data.get('department');
    const date = data.get('date') || new Date().toISOString().split('T')[0];
    const notes = data.get('notes');

    if (!hasPermission('allocate', allocateModal.category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to allocate ${allocateModal.category} assets.`, "error");
      return;
    }

    const qty = parseInt(data.get('quantity') || 1);

    if (allocateModal.availableQuantity < qty) {
      addToast("Validation Error", `Not enough stock. Available: ${allocateModal.availableQuantity}, Requested: ${qty}`, "error");
      return;
    }

    // From here on the button shows a spinner and is disabled. The finally block
    // clears it, so it re-enables on failure and after a successful close alike.
    if (!isApiConnected) {
      addToast("Not Connected", "Cannot reach the server. The allocation was not saved.", "error");
      return;
    }

    setIsAllocating(true);
    try {
      try {
        await api.createAssignment({
          assetId,
          employeeName: employee,
          quantity: qty,
          department: dept,
          notes,
          date
        });
        const [updatedAssets, updatedAssignments] = await Promise.all([
          api.getAssets(),
          api.getAssignments()
        ]);
        setAssets(updatedAssets);
        setAssignments(updatedAssignments);
      } catch (err) {
        addToast("Database Error", err.message || "Failed to allocate asset in PostgreSQL.", "error");
        return;
      }

    const newMvt = {
      assetId,
      date,
      type: "Allocation",
      from: "Inventory",
      to: `${employee} (${dept})`,
      actor: currentRole,
      notes: `Allocated Qty: ${qty}. ${notes || ''}`
    };
    // Persist first, then reflect the row the database actually created (with its
    // real SERIAL id) rather than a client-invented one.
    try {
      const savedMvt = await api.createMovement(newMvt);
      setMovements(prev => [savedMvt || newMvt, ...prev]);
    } catch (err) {
      console.error("Failed to save movement to DB:", err);
    }

    await addAuditLog("Asset Allocation", `Assigned ${qty} units of ${assetId} to ${employee}`);
    addToast("Asset Allocated", `Asset ${assetId} (${qty} units) assigned to ${employee}.`, "success");
    setAllocateModal(null);
    } finally {
      setIsAllocating(false);
    }
  };

  // Handle asset transfer
  const handleTransfer = async (e) => {
    e.preventDefault();
    // Re-entry guard: a second submit (double click, Enter while the first is in
    // flight) would double-write the movement. Bail before any work runs.
    if (isTransferring) return;
    const data = new FormData(e.target);
    const assetId = transferModal.id;
    const target = data.get('targetType'); // employee or department
    const newEmployee = data.get('employee');
    const newDept = data.get('department');
    const newLocation = data.get('location');
    const date = data.get('date') || new Date().toISOString().split('T')[0];
    const notes = data.get('notes');

    if (!hasPermission('allocate', transferModal.category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to transfer ${transferModal.category} assets.`, "error");
      return;
    }

    // The server rejects unknown custodians too; checking here turns a 400 into a
    // clear message before anything is written.
    if (target === 'employee') {
      if (!newEmployee) {
        addToast("Employee Required", "Select the employee who will take custody of this asset.", "error");
        return;
      }
      if (!findEmployeeByName(newEmployee)) {
        addToast("Invalid Employee", `"${newEmployee}" is not an active employee in the directory.`, "error");
        return;
      }
    }

    // A custody change is not just a rename on the asset: it must move the underlying
    // asset_assignments rows, or the Active Custodian Registry, employee lookups and
    // counts (all read from those rows) keep showing the previous holder. That has to
    // happen atomically on the server, so the transfer now needs a live connection.
    if (!isApiConnected) {
      addToast("Not Connected", "Cannot reach the server. The transfer was not saved.", "error");
      return;
    }

    const prevEmployee = transferModal.assignedEmployee;
    const prevDept = transferModal.department;
    const prevLoc = transferModal.location;
    const destination = target === 'employee' ? `${newEmployee} (${newDept})` : `Dept: ${newDept} (${newLocation})`;
    const source = prevEmployee ? `${prevEmployee} (${prevDept})` : `Dept: ${prevDept} (${prevLoc})`;

    // From here on the button shows a spinner and is disabled. The finally block
    // clears it, so it re-enables on failure and after a successful close alike.
    setIsTransferring(true);
    try {
      try {
        // Database first: this endpoint reassigns the custody rows, updates the asset
        // and records the movement in one transaction.
        await api.transferAsset(assetId, {
          targetType: target,
          employeeName: target === 'employee' ? newEmployee : '',
          department: newDept,
          location: newLocation,
          date,
          notes
        });
      } catch (err) {
        addToast("Transfer Failed", err.message || "Failed to transfer asset.", "error");
        return;
      }

      // Then synchronise the frontend: re-read every view the transfer touched so the
      // registry, movement ledger, asset table, dashboards and employee lookups all
      // reflect the new custodian without a manual refresh.
      try {
        const [updatedAssets, updatedAssignments, updatedMovements] = await Promise.all([
          api.getAssets(),
          api.getAssignments(),
          api.getMovements()
        ]);
        setAssets(updatedAssets);
        setAssignments(updatedAssignments);
        setMovements(updatedMovements);
      } catch (err) {
        console.error("Failed to refresh state after transfer:", err);
      }

      await addAuditLog("Asset Transfer", `Transferred ${assetId} from ${source} to ${destination}`);
      addToast("Asset Transferred", `Asset ${assetId} moved successfully.`, "success");
      setTransferModal(null);
      setTransferTargetType('employee');
      setTransferEmployee('');
    } finally {
      setIsTransferring(false);
    }
  };

  // Handle return
  const [handleReturn, returningAsset] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const assetId = returnModal.id;
    const location = data.get('location');
    const date = data.get('date') || new Date().toISOString().split('T')[0];
    const notes = data.get('notes');

    if (!hasPermission('allocate', returnModal.category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to handle asset returns.`, "error");
      return;
    }

    const prevEmployee = returnModal.assignedEmployee;
    const prevDept = returnModal.department;

    if (isApiConnected) {
      try {
        await api.updateAsset(assetId, { status: "Available", assignedEmployee: '', location });
      } catch {
        addToast("Database Error", "Failed to process asset return in PostgreSQL.", "error");
        return;
      }
    }

    setAssets(prev => prev.map(a => {
      if (a.id === assetId) {
        return { ...a, status: "Available", assignedEmployee: '', location };
      }
      return a;
    }));

    const newMvt = {
      id: `MVT-${Date.now()}`,
      assetId,
      date,
      type: "Return",
      from: `${prevEmployee} (${prevDept})`,
      to: `Inventory (${location})`,
      actor: currentRole,
      notes
    };
    setMovements(prev => [newMvt, ...prev]);
    if (isApiConnected) {
      try {
        await api.createMovement(newMvt);
      } catch (err) {
        console.error("Failed to save movement to DB:", err);
      }
    }

    await addAuditLog("Asset Return", `Returned ${assetId} to inventory at ${location}`);
    addToast("Asset Returned", `Asset ${assetId} returned to inventory.`, "success");
    setReturnModal(null);
  });

  // Handle Edit Assignment Submit
  const [handleEditAssignmentSubmit, savingAssignment] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const id = editAssignmentModal.id;
    const assetId = editAssignmentModal.assetId;
    const newEmployee = data.get('employeeName');
    const newDept = data.get('department');
    const newQty = parseInt(data.get('quantity'));
    const notes = data.get('notes');

    // Get asset
    const asset = assets.find(a => a.id === assetId);
    const qtyDiff = newQty - editAssignmentModal.quantity;
    if (asset.availableQuantity < qtyDiff) {
      addToast("Validation Error", `Not enough available stock to adjust assignment. Available: ${asset.availableQuantity}, Requested adjustment: ${qtyDiff}`, "error");
      return;
    }

    if (!isApiConnected) {
      addToast("Not Connected", "Cannot reach the server. The change was not saved.", "error");
      return;
    }
    try {
      await api.updateAssignment(id, {
        employeeName: newEmployee,
        department: newDept,
        quantity: newQty,
        notes
      });
      const [updatedAssets, updatedAssignments] = await Promise.all([
        api.getAssets(),
        api.getAssignments()
      ]);
      setAssets(updatedAssets);
      setAssignments(updatedAssignments);
    } catch (err) {
      addToast("Update Failed", err.message, "error");
      return;
    }

    await addAuditLog("Assignment Edit", `Updated assignment details for asset ${assetId}`);
    addToast("Assignment Updated", "Assignment details saved successfully.", "success");
    setEditAssignmentModal(null);
  });

  // Handle Return Assignment Submit
  const [handleReturnAssignmentSubmit, returningAssignment] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const id = returnAssignmentModal.id;
    const assetId = returnAssignmentModal.assetId;
    const returnQty = parseInt(data.get('quantity') || returnAssignmentModal.quantity);
    const location = data.get('location') || 'Inventory';
    const notes = data.get('notes');

    if (returnQty <= 0 || returnQty > returnAssignmentModal.quantity) {
      addToast("Validation Error", "Invalid return quantity.", "error");
      return;
    }

    if (!isApiConnected) {
      addToast("Not Connected", "Cannot reach the server. The return was not saved.", "error");
      return;
    }
    try {
      await api.returnAssignment(id, returnQty, notes);
      const [updatedAssets, updatedAssignments, dbMovements] = await Promise.all([
        api.getAssets(),
        api.getAssignments(),
        api.getMovements()
      ]);
      setAssets(updatedAssets);
      setAssignments(updatedAssignments);
      setMovements(dbMovements);
    } catch (err) {
      addToast("Return Failed", err.message, "error");
      return;
    }

    await addAuditLog("Asset Return", `Returned ${returnQty} units of asset ${assetId} to inventory at ${location}`);
    addToast("Asset Returned", "Returned quantity checked in successfully.", "success");
    setReturnAssignmentModal(null);
  });

  // Handle disposal
  const handleDisposeAsset = async (asset, reason) => {
    if (!hasPermission('write', asset.category)) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to dispose assets.`, "error");
      return;
    }

    const date = new Date().toISOString().split('T')[0];

    if (isApiConnected) {
      try {
        await api.updateAsset(asset.id, {
          status: "Disposed",
          assignedEmployee: '',
          disposalDate: date,
          disposalReason: reason
        });
      } catch {
        addToast("Database Error", "Failed to dispose asset in PostgreSQL.", "error");
        return;
      }
    }

    setAssets(prev => prev.map(a => {
      if (a.id === asset.id) {
        return {
          ...a,
          status: "Disposed",
          assignedEmployee: '',
          disposalDate: date,
          disposalReason: reason
        };
      }
      return a;
    }));

    const newMvt = {
      id: `MVT-${Date.now()}`,
      assetId: asset.id,
      date,
      type: "Disposal",
      from: asset.assignedEmployee ? `${asset.assignedEmployee} (${asset.department})` : "Inventory",
      to: `Disposed (${reason})`,
      actor: currentRole,
      notes: `Retired: ${reason}`
    };
    setMovements(prev => [newMvt, ...prev]);
    if (isApiConnected) {
      try {
        await api.createMovement(newMvt);
      } catch (err) {
        console.error("Failed to save movement to DB:", err);
      }
    }

    await addAuditLog("Asset Disposal", `Retired asset ${asset.id} due to: ${reason}`);
    addToast("Asset Retired", `Asset ${asset.id} marked as Disposed.`, "success");
  };

  // Bulk Asset Handlers
  const handleBulkDeleteAssets = async () => {
    const isPermitted = selectedAssetIds.every(id => {
      const asset = assets.find(a => a.id === id);
      return hasPermission('delete', asset?.category);
    });

    if (!isPermitted) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to delete one or more selected assets.`, "error");
      return;
    }

    if (!window.confirm(`Are you sure you want to permanently delete the ${selectedAssetIds.length} selected asset records?`)) {
      return;
    }

    try {
      if (isApiConnected) {
        await api.bulkDeleteAssets(selectedAssetIds);
      }
      setAssets(prev => prev.filter(a => !selectedAssetIds.includes(a.id)));
      if (!(await refreshAssignments())) {
        setAssignments(prev => prev.filter(asg => !selectedAssetIds.includes(asg.assetId)));
      }
      setSelectedAssetIds([]);
      addToast("Success", "Selected assets deleted successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to delete assets.", "error");
    }
  };

  const handleBulkAssetStatusChange = async (status) => {
    const isPermitted = selectedAssetIds.every(id => {
      const asset = assets.find(a => a.id === id);
      return hasPermission('write', asset?.category);
    });

    if (!isPermitted) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to edit one or more selected assets.`, "error");
      return;
    }

    try {
      if (isApiConnected) {
        await api.bulkUpdateAssetsStatus(selectedAssetIds, status);
      }
      setAssets(prev => prev.map(a => selectedAssetIds.includes(a.id) ? { ...a, status } : a));
      setSelectedAssetIds([]);
      addToast("Success", "Asset status updated successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update asset status.", "error");
    }
  };

  const handleBulkAssetCategoryChange = async () => {
    const isPermitted = selectedAssetIds.every(id => {
      const asset = assets.find(a => a.id === id);
      return hasPermission('write', asset?.category);
    });

    if (!isPermitted) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to edit one or more selected assets.`, "error");
      return;
    }

    try {
      if (isApiConnected) {
        await api.bulkUpdateAssetsCategory(selectedAssetIds, bulkAssetCategoryValue);
      }
      setAssets(prev => prev.map(a => selectedAssetIds.includes(a.id) ? { ...a, category: bulkAssetCategoryValue } : a));
      setSelectedAssetIds([]);
      setShowBulkAssetCategory(false);
      addToast("Success", "Asset categories updated successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update asset categories.", "error");
    }
  };

  const handleBulkAssetLocationChange = async () => {
    const isPermitted = selectedAssetIds.every(id => {
      const asset = assets.find(a => a.id === id);
      return hasPermission('write', asset?.category);
    });

    if (!isPermitted) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to edit one or more selected assets.`, "error");
      return;
    }

    try {
      if (isApiConnected) {
        await api.bulkUpdateAssetsLocation(selectedAssetIds, bulkAssetLocationValue);
      }
      setAssets(prev => prev.map(a => selectedAssetIds.includes(a.id) ? { ...a, location: bulkAssetLocationValue } : a));
      setSelectedAssetIds([]);
      setShowBulkAssetLocation(false);
      addToast("Success", "Asset locations updated successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update asset locations.", "error");
    }
  };

  const handleBulkAssetDeptChange = async () => {
    const isPermitted = selectedAssetIds.every(id => {
      const asset = assets.find(a => a.id === id);
      return hasPermission('write', asset?.category);
    });

    if (!isPermitted) {
      addToast("Access Denied", `Your role (${currentRole}) is not permitted to edit one or more selected assets.`, "error");
      return;
    }

    try {
      if (isApiConnected) {
        await api.bulkUpdateAssetsDepartment(selectedAssetIds, bulkAssetDeptValue);
      }
      setAssets(prev => prev.map(a => selectedAssetIds.includes(a.id) ? { ...a, department: bulkAssetDeptValue } : a));
      setSelectedAssetIds([]);
      setShowBulkAssetDept(false);
      addToast("Success", "Asset departments updated successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update asset departments.", "error");
    }
  };

  // Manage Invoice status
  const handleInvoicePaymentStatus = async (id, newStatus) => {
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only the Finance Team or Super Admins can process payments.", "error");
      return;
    }

    if (isApiConnected) {
      try {
        await api.updateInvoice(id, { paymentStatus: newStatus });
      } catch {
        addToast("Database Error", "Failed to update payment status in PostgreSQL.", "error");
        return;
      }
    }

    setInvoices(prev => prev.map(inv => {
      if (inv.id === id) {
        return { ...inv, paymentStatus: newStatus };
      }
      return inv;
    }));

    await addAuditLog("Payment Processing", `Updated invoice ${id} payment status to ${newStatus}`);
    addToast("Payment Updated", `Invoice ${id} marked as ${newStatus}.`, "success");
  };

  // Bulk Delete Invoices
  const handleBulkDeleteInvoices = async () => {
    if (selectedInvoiceIds.length === 0) return;
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only the Finance Team or Super Admins can delete invoices.", "error");
      return;
    }
    if (!window.confirm(`Are you sure you want to permanently delete the ${selectedInvoiceIds.length} selected invoices?`)) {
      return;
    }
    try {
      if (isApiConnected) {
        await api.bulkDeleteInvoices(selectedInvoiceIds);
      }
      setInvoices(prev => prev.filter(inv => !selectedInvoiceIds.includes(inv.id)));
      setSelectedInvoiceIds([]);
      addToast("Success", "Selected invoices deleted successfully.", "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to delete invoices.", "error");
    }
  };

  // Bulk Invoice Status Change
  const handleBulkInvoiceStatusChange = async (status) => {
    if (selectedInvoiceIds.length === 0) return;
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only the Finance Team can update invoice status.", "error");
      return;
    }
    try {
      if (isApiConnected) {
        await api.bulkUpdateInvoicesStatus(selectedInvoiceIds, status);
      }
      setInvoices(prev => prev.map(inv => selectedInvoiceIds.includes(inv.id) ? { ...inv, paymentStatus: status } : inv));
      setSelectedInvoiceIds([]);
      addToast("Success", `Selected invoices status updated to ${status}.`, "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update invoices status.", "error");
    }
  };

  // Bulk Export Invoices to Excel. xlsx is imported on demand to keep it out of the
  // initial bundle.
  const handleBulkExportInvoices = async () => {
    const listToExport = selectedInvoiceIds.length > 0
      ? invoices.filter(inv => selectedInvoiceIds.includes(inv.id))
      : invoices;

    if (listToExport.length === 0) {
      addToast("No Data", "No invoices available to export.", "error");
      return;
    }

    const XLSX = await import('xlsx');

    const data = listToExport.map(inv => {
      const amountNum = Number(inv.amount || 0);
      const gstNum = Number(inv.gst || 0);
      return {
        "Invoice ID": inv.id,
        "PO Reference": inv.poReference,
        "Vendor": inv.vendor,
        "Issue Date": inv.date,
        "Base Value (₹)": amountNum,
        "GST (%)": gstNum,
        "Total Value (₹)": amountNum + (amountNum * (gstNum / 100)),
        "Payment Status": inv.paymentStatus,
        "PDF Filename": inv.fileName || "None"
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Invoices Export");
    XLSX.writeFile(wb, `invoices_export_${new Date().toISOString().slice(0,10)}.xlsx`);
    addToast("Exported", `${listToExport.length} invoices exported successfully.`, "success");
  };

  // Upload PDF for specific Invoice
  const handleUploadPdfForInvoice = async (invoiceId, file) => {
    if (!file) return;
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only the Finance Team can upload invoices.", "error");
      return;
    }
    
    let fileName = file.name;
    let fileSize = `${(file.size / 1024).toFixed(1)} KB`;
    let fileUrl = "";

    try {
      if (isApiConnected) {
        const uploadResult = await api.uploadFile(file);
        fileName = uploadResult.name;
        fileSize = uploadResult.fileSize;
        fileUrl = uploadResult.fileUrl;
        
        await api.updateInvoice(invoiceId, { fileName });
      }

      setInvoices(prev => prev.map(inv => {
        if (inv.id === invoiceId) {
          return { ...inv, fileName };
        }
        return inv;
      }));

      // The database assigns the document id; reflect the row it returns.
      const newDoc = {
        name: fileName,
        type: "Invoice",
        size: fileSize,
        uploadDate: new Date().toISOString().split('T')[0],
        association: `Invoice ${invoiceId}`,
        fileUrl
      };
      const savedDoc = await api.createDocument(newDoc);
      setDocuments(prev => [savedDoc || newDoc, ...prev]);

      addToast("Success", `Invoice PDF uploaded successfully for ${invoiceId}.`, "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to upload invoice PDF.", "error");
    }
  };

  // Invoice-to-asset mapping. `assetIds` is the complete desired set for the
  // invoice, so this adds, removes and replaces in one call. An empty set
  // unlinks every asset.
  const [handleBulkMapAssetsToInvoice, mappingInvoiceAssets] = useAsyncAction(async (invoiceId, commaSeparatedAssetIds) => {
    if (!invoiceId) {
      addToast("Error", "Please select an Invoice ID.", "error");
      return;
    }
    const assetIds = Array.from(new Set(
      commaSeparatedAssetIds.split(',').map(id => id.trim()).filter(Boolean)
    ));

    const previouslyMapped = assets.filter(a => a.invoiceId === invoiceId).map(a => a.id);
    const removed = previouslyMapped.filter(id => !assetIds.includes(id));
    const added = assetIds.filter(id => !previouslyMapped.includes(id));

    if (removed.length === 0 && added.length === 0) {
      addToast("No changes", `Invoice ${invoiceId} already has exactly these assets.`, "info");
      return;
    }

    try {
      // The server returns the authoritative set after the write; trust it over
      // any locally-derived guess so the two views cannot drift apart.
      let finalAssetIds = assetIds;
      if (isApiConnected) {
        const result = await api.setInvoiceAssets(invoiceId, assetIds);
        if (Array.isArray(result?.assetIds)) finalAssetIds = result.assetIds;
      }

      setAssets(prev => prev.map(asset => {
        if (finalAssetIds.includes(asset.id)) {
          return { ...asset, invoiceId };
        }
        // Anything that was on this invoice but is not in the final set is now unlinked.
        // Omitting this is why de-selected assets kept their old invoice and reappeared.
        if (asset.invoiceId === invoiceId) {
          return { ...asset, invoiceId: null };
        }
        return asset;
      }));

      setInvoices(prev => prev.map(inv => {
        if (inv.id === invoiceId) {
          return { ...inv, mappedAssets: finalAssetIds };
        }
        // An asset can only belong to one invoice, so drop any it took from others.
        const otherMapped = (inv.mappedAssets || []).filter(aid => !finalAssetIds.includes(aid));
        return { ...inv, mappedAssets: otherMapped };
      }));

      const parts = [];
      if (added.length) parts.push(`${added.length} linked`);
      if (removed.length) parts.push(`${removed.length} unlinked`);
      addToast("Mapping updated", `Invoice ${invoiceId}: ${parts.join(', ')}.`, "success");
    } catch (err) {
      addToast("Error", err.message || "Failed to update invoice mapping.", "error");
    }
  });

  // Register AMC Contract
  const [handleAddAMC, addingAmc] = useAsyncAction(async (e) => {
    e.preventDefault();
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only Finance Team or Super Admins can register AMCs.", "error");
      return;
    }

    const data = new FormData(e.target);
    const cost = parseFloat(data.get('cost') || 0);
    const fileInput = e.target.agreementFile;
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;

    let agreementFile = "agreement.pdf";

    if (file && isApiConnected) {
      try {
        const uploadResult = await api.uploadFile(file);
        agreementFile = uploadResult.fileUrl;
      } catch {
        addToast("Upload Error", "Failed to upload contract agreement scan.", "error");
        return;
      }
    } else if (file) {
      agreementFile = file.name;
    }

    const poNumber = String(data.get('poNumber') || '').trim();
    if (!poNumber) {
      addToast("PO Number Required", "An AMC contract must carry a Purchase Order number.", "error");
      return;
    }
    // Uniqueness is enforced by the database; check locally too so the operator is
    // told before the upload and insert are attempted.
    if (amcs.some(a => (a.poNumber || '').toLowerCase() === poNumber.toLowerCase())) {
      addToast("Duplicate PO Number", `PO Number "${poNumber}" is already used by another AMC contract.`, "error");
      return;
    }

    const newAmc = {
      id: `AMC-${String(amcs.length + 101).padStart(3, '0')}`,
      poNumber,
      vendor: data.get('vendor'),
      cost,
      startDate: data.get('startDate'),
      endDate: data.get('endDate'),
      mappedAssets: [],
      serviceSchedule: data.get('serviceSchedule'),
      agreementFile,
      serviceHistory: []
    };

    if (isApiConnected) {
      try {
        await api.createAmc(newAmc);
      } catch (err) {
        addToast("Could not register AMC", err.message || "Failed to save AMC contract.", "error");
        return;
      }
    }

    setAmcs(prev => [newAmc, ...prev]);
    await addAuditLog("AMC Registration", `Registered AMC contract ${newAmc.id} with ${newAmc.vendor}`);
    addToast("AMC Registered", `Contract ${newAmc.id} created successfully.`, "success");
    e.target.reset();
    setNewAmcServiceSchedule('Monthly');
  });

  // Link Asset to AMC
  const [handleMapAssetToAmc, mappingAmcAsset] = useAsyncAction(async (amcId, assetId) => {
    if (!hasPermission('finance')) return;

    // Check if asset exists
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      addToast("Invalid Asset", `Asset ${assetId} not found.`, "error");
      return;
    }

    if (isApiConnected) {
      try {
        await api.updateAsset(assetId, { amcId });
      } catch {
        addToast("Database Error", "Failed to map asset to AMC in PostgreSQL.", "error");
        return;
      }
    }

    setAmcs(prev => prev.map(amc => {
      if (amc.id === amcId) {
        if (amc.mappedAssets.includes(assetId)) return amc;
        return { ...amc, mappedAssets: [...amc.mappedAssets, assetId] };
      }
      return amc;
    }));

    setAssets(prev => prev.map(a => {
      if (a.id === assetId) {
        return { ...a, amcId };
      }
      return a;
    }));

    await addAuditLog("AMC Asset Mapping", `Mapped asset ${assetId} to AMC Contract ${amcId}`);
    addToast("Asset Mapped", `${assetId} linked to ${amcId}.`, "success");
  });

  // Register Invoice
  const [handleAddInvoice, addingInvoice] = useAsyncAction(async (e) => {
    e.preventDefault();
    if (!hasPermission('finance')) {
      addToast("Access Denied", "Only Finance Team or Super Admins can upload invoices.", "error");
      return;
    }

    const data = new FormData(e.target);
    const amount = parseFloat(data.get('amount') || 0);
    const gst = parseFloat(data.get('gst') || 0);
    const fileInput = e.target.fileName;
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    const linkAssetIdsStr = data.get('linkAssetIds') || '';
    const linkAssetIds = linkAssetIdsStr.split(',').map(s => s.trim()).filter(Boolean);

    let fileName = "";
    let fileSize = "";
    let fileUrl = "";

    if (file) {
      if (isApiConnected) {
        try {
          const uploadResult = await api.uploadFile(file);
          fileName = uploadResult.name;
          fileSize = uploadResult.fileSize;
          fileUrl = uploadResult.fileUrl;
        } catch (err) {
          addToast("Upload Error", err.message || "Failed to upload file attachment.", "error");
          return;
        }
      } else {
        fileName = file.name;
        fileSize = `${(file.size / 1024).toFixed(1)} KB`;
      }
    }

    // Generate safe unique Invoice ID
    const maxInvIdNum = invoices.reduce((max, inv) => {
      const num = parseInt(inv.id.replace('INV-', ''));
      return isNaN(num) ? max : Math.max(max, num);
    }, 100);
    const newInvId = `INV-${maxInvIdNum + 1}`;

    const newInv = {
      id: newInvId,
      poReference: data.get('poReference'),
      vendor: data.get('vendor'),
      amount,
      gst,
      date: data.get('date') || new Date().toISOString().split('T')[0],
      paymentStatus: "Pending",
      mappedAssets: linkAssetIds,
      fileName: fileName || "None"
    };

    let newDoc = null;
    if (file) {
      // Generate safe unique Document ID
      const maxDocIdNum = documents.reduce((max, doc) => {
        const num = parseInt(doc.id.replace('DOC-', ''));
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      const newDocId = `DOC-${String(maxDocIdNum + 1).padStart(3, '0')}`;

      newDoc = {
        id: newDocId,
        name: fileName,
        type: "Invoice",
        size: fileSize,
        uploadDate: newInv.date,
        association: `Invoice ${newInv.id}`,
        fileUrl
      };
    }

    if (isApiConnected) {
      try {
        await api.createInvoice(newInv);
        if (newDoc) {
          await api.createDocument(newDoc);
        }
        if (linkAssetIds.length > 0) {
          await api.bulkMapAssetsToInvoice(newInvId, linkAssetIds);
        }
      } catch (err) {
        addToast("Database Error", err.message || "Failed to save invoice/document to PostgreSQL.", "error");
        return;
      }
    }

    setInvoices(prev => [newInv, ...prev]);
    if (newDoc) {
      setDocuments(prev => [newDoc, ...prev]);
    }
    if (linkAssetIds.length > 0) {
      setAssets(prev => prev.map(asset => {
        if (linkAssetIds.includes(asset.id)) {
          return { ...asset, invoiceId: newInvId };
        }
        return asset;
      }));
    }

    await addAuditLog("Invoice Registration", `Registered invoice ${newInv.id} from ${newInv.vendor}`);
    addToast("Invoice Registered", `Invoice ${newInv.id} registered successfully.`, "success");
    e.target.reset();
  });

  // Upload Document
  const [handleUploadDocument, uploadingDocument] = useAsyncAction(async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const fileInput = e.target.file;
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;

    let fileName = data.get('name') || "document.pdf";
    let fileSize = "1.5 MB";
    let fileUrl = "";

    if (file && isApiConnected) {
      try {
        const uploadResult = await api.uploadFile(file);
        if (!fileName) fileName = uploadResult.name;
        fileSize = uploadResult.fileSize;
        fileUrl = uploadResult.fileUrl;
      } catch {
        addToast("Upload Error", "Failed to upload file to backend.", "error");
        return;
      }
    } else if (file) {
      if (!fileName) fileName = file.name;
      fileSize = `${(file.size / 1024).toFixed(1)} KB`;
    }

    const newDoc = {
      name: fileName,
      type: data.get('type'),
      size: fileSize,
      uploadDate: new Date().toISOString().split('T')[0],
      association: data.get('association') || "General",
      fileUrl
    };

    // Database-only: the server assigns the id and returns the stored row.
    let savedDoc = newDoc;
    if (!isApiConnected) {
      addToast("Not Connected", "Cannot reach the server. The document was not saved.", "error");
      return;
    }
    try {
      savedDoc = await api.createDocument(newDoc) || newDoc;
    } catch (err) {
      addToast("Database Error", err.message || "Failed to save document.", "error");
      return;
    }

    setDocuments(prev => [savedDoc, ...prev]);
    await addAuditLog("Document Upload", `Uploaded document ${savedDoc.name} (${savedDoc.type})`);
    addToast("Document Uploaded", `${newDoc.name} stored in repository.`, "success");
    e.target.reset();
    setNewDocCategory('Invoice');
  });

  // Add AMC service history
  const [handleAddAMCServiceRecord, addingServiceRecord] = useAsyncAction(async (e, amcId) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const date = data.get('date');
    const type = data.get('type');
    const notes = data.get('notes');

    const amc = amcs.find(a => a.id === amcId);
    if (!amc) return;

    const updatedServiceHistory = [
      { date, type, notes },
      ...(amc.serviceHistory || [])
    ];

    if (isApiConnected) {
      try {
        await api.updateAmc(amcId, { serviceHistory: updatedServiceHistory });
      } catch {
        addToast("Database Error", "Failed to save service record in PostgreSQL.", "error");
        return;
      }
    }

    setAmcs(prev => prev.map(amc => {
      if (amc.id === amcId) {
        return {
          ...amc,
          serviceHistory: updatedServiceHistory
        };
      }
      return amc;
    }));

    await addAuditLog("AMC Maintenance", `Logged service record for contract ${amcId}`);
    addToast("Service Logged", "Maintenance service details saved.", "success");
    e.target.reset();
  });

  // Generate Reports
  const generateReportData = () => {
    if (reportType === 'inventory') {
      setGeneratedReport(assets);
    } else if (reportType === 'allocation') {
      setGeneratedReport(assets.filter(a => a.assignedQuantity > 0 || a.status === 'Assigned'));
    } else if (reportType === 'amc') {
      setGeneratedReport(amcs);
    } else if (reportType === 'invoices') {
      setGeneratedReport(invoices);
    } else if (reportType === 'disposal') {
      setGeneratedReport(assets.filter(a => a.status === 'Disposed'));
    } else if (reportType === 'movement') {
      setGeneratedReport(movements);
    }
  };

  useEffect(() => {
    generateReportData();
  }, [reportType, assets, amcs, invoices, movements]);

  // Export report to CSV helper
  const handleExportCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    if (generatedReport.length === 0) return;

    // Build headers from object keys
    const headers = Object.keys(generatedReport[0]);
    csvContent += headers.join(",") + "\n";

    generatedReport.forEach(row => {
      const values = headers.map(header => {
        let val = row[header];
        if (typeof val === 'object' && val !== null) {
          val = JSON.stringify(val).replace(/"/g, '""');
        } else if (typeof val === 'string') {
          val = val.replace(/"/g, '""');
        }
        return `"${val}"`;
      });
      csvContent += values.join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${reportType}_report_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addToast("Report Exported", "Downloaded CSV report sheet.", "success");
  };

  // Export report to PDF helper. jsPDF (and its html2canvas/purify deps) is loaded on
  // demand so it stays out of the initial bundle.
  const handleExportPDF = async () => {
    if (generatedReport.length === 0) {
      addToast("Export Empty", "No data to export.", "warning");
      return;
    }

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(`AssetFlow Compliance Report - ${reportType.toUpperCase()}`, 14, 20);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, 28);

    const headers = Object.keys(generatedReport[0]).filter(k => k !== 'serviceHistory' && k !== 'mappedAssets');
    let startY = 38;
    let startX = 14;
    const colWidth = Math.floor(270 / headers.length);

    doc.setFont("helvetica", "bold");
    headers.forEach((h, i) => {
      const cleanHeader = h.replace(/([A-Z])/g, ' $1').toUpperCase();
      doc.text(cleanHeader, startX + (i * colWidth), startY);
    });

    doc.line(14, startY + 2, 280, startY + 2);

    doc.setFont("helvetica", "normal");
    let currentY = startY + 8;

    generatedReport.forEach((row) => {
      if (currentY > 190) {
        doc.addPage();
        currentY = 20;
        doc.setFont("helvetica", "bold");
        headers.forEach((h, i) => {
          doc.text(h.toUpperCase(), startX + (i * colWidth), currentY);
        });
        doc.line(14, currentY + 2, 280, currentY + 2);
        doc.setFont("helvetica", "normal");
        currentY += 8;
      }

      headers.forEach((h, colIndex) => {
        let val = row[h];
        if (typeof val === 'object' && val !== null) {
          val = JSON.stringify(val);
        }
        const textVal = String(val === undefined || val === null ? '' : val);
        const truncated = textVal.length > 20 ? textVal.substring(0, 18) + '..' : textVal;
        doc.text(truncated, startX + (colIndex * colWidth), currentY);
      });

      currentY += 7;
    });

    doc.save(`${reportType}_report_${new Date().toISOString().split('T')[0]}.pdf`);
    addToast("Report Exported", "Downloaded PDF document report.", "success");
  };

  // Export report to Excel helper. xlsx is a large dependency, so it is imported on
  // demand rather than shipped in the initial bundle.
  const handleExportExcel = async () => {
    if (generatedReport.length === 0) {
      addToast("Export Empty", "No data to export.", "warning");
      return;
    }

    const XLSX = await import('xlsx');
    const cleanData = generatedReport.map(item => {
      const cleanItem = {};
      Object.keys(item).forEach(key => {
        const readableKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
        let val = item[key];
        if (typeof val === 'object' && val !== null) {
          val = JSON.stringify(val);
        }
        cleanItem[readableKey] = val;
      });
      return cleanItem;
    });

    const worksheet = XLSX.utils.json_to_sheet(cleanData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Report Data");

    const maxCols = cleanData.reduce((acc, row) => {
      Object.keys(row).forEach((key, i) => {
        const cellLength = Math.max(String(row[key] || '').length, key.length);
        acc[i] = Math.max(acc[i] || 0, cellLength);
      });
      return acc;
    }, []);
    worksheet['!cols'] = maxCols.map(w => ({ wch: w + 2 }));

    XLSX.writeFile(workbook, `${reportType}_report_${new Date().toISOString().split('T')[0]}.xlsx`);
    addToast("Report Exported", "Downloaded Excel spreadsheet (.xlsx).", "success");
  };

  // Simulate Scan code reader
  const handleSimulateScan = (assetId) => {
    if (!assetId) return;
    setIsScanning(true);
    setTimeout(() => {
      setIsScanning(false);
      const asset = assets.find(a => a.id === assetId);
      if (asset) {
        setAssetDetailModal(asset);
        addToast("QR Code Scanned", `Asset lookup found: ${asset.id}`, "success");
      } else {
        addToast("Scan Failed", "Asset code not matching system database.", "error");
      }
    }, 1500);
  };

  // Filter Assets selector logic
  const filteredAssets = assets.filter(asset => {
    // Employees are already scoped server-side (GET /api/assets joins asset_assignments
    // on the caller's user_id). The old client check compared assets.assignedEmployee
    // against a hardcoded "Alice Johnson", but that column stores a display summary
    // like "Alice Johnson (1)", so it matched nothing and employees saw an empty list.
    // Offline mode has no server to scope for us, so fall back to a name match there.
    if (currentRole === 'Employee' && !isApiConnected) {
      const me = currentUser?.name;
      if (!me || !String(asset.assignedEmployee || '').includes(me)) return false;
    }

    // Find mapped invoice vendor
    const mappedInvoice = invoices.find(inv => inv.id === asset.invoiceId);
    const invoiceVendor = mappedInvoice ? mappedInvoice.vendor : '';

    // Find mapped AMC vendor
    const mappedAmc = amcs.find(a => a.id === asset.amcId);
    const amcVendor = mappedAmc ? mappedAmc.vendor : '';

    // Search query matches Code, Name, Serial Number, Department, Employee, Location, Invoice, Vendor, Category, Status
    const query = searchQuery.toLowerCase();
    const matchQuery =
      (asset.id || '').toLowerCase().includes(query) ||
      (asset.name || '').toLowerCase().includes(query) ||
      (asset.serialNumber || '').toLowerCase().includes(query) ||
      (asset.department || '').toLowerCase().includes(query) ||
      (asset.assignedEmployee || '').toLowerCase().includes(query) ||
      (asset.location || '').toLowerCase().includes(query) ||
      (asset.invoiceId || '').toLowerCase().includes(query) ||
      (asset.category || '').toLowerCase().includes(query) ||
      (asset.status || '').toLowerCase().includes(query) ||
      invoiceVendor.toLowerCase().includes(query) ||
      amcVendor.toLowerCase().includes(query);

    const matchCategory = assetFilterCategory === 'All' || asset.category === assetFilterCategory;
    const matchStatus = assetFilterStatus === 'All' || asset.status === assetFilterStatus;
    const matchDept = assetFilterDept === 'All' || asset.department === assetFilterDept;

    return matchQuery && matchCategory && matchStatus && matchDept;
  });

  // Derived dashboard stats
  // Derived dashboard stats
  const totalAssetsCount = currentRole === 'Employee' 
    ? assignments.filter(asg => asg.employeeName === currentUser?.name && asg.status === 'Assigned').reduce((acc, c) => acc + c.quantity, 0)
    : assets.reduce((acc, a) => acc + (a.totalQuantity !== undefined ? a.totalQuantity : 1), 0);

  const assignedCount = currentRole === 'Employee'
    ? assignments.filter(asg => asg.employeeName === currentUser?.name && asg.status === 'Assigned').reduce((acc, c) => acc + c.quantity, 0)
    : assets.reduce((acc, a) => acc + (a.assignedQuantity !== undefined ? a.assignedQuantity : 0), 0);

  const availableCount = currentRole === 'Employee' 
    ? 0 
    : assets.reduce((acc, a) => acc + (a.availableQuantity !== undefined ? a.availableQuantity : 1), 0);

  const maintenanceCount = currentRole === 'Employee' 
    ? 0 
    : assets.filter(a => a.status === 'Under Maintenance').reduce((acc, a) => acc + (a.totalQuantity !== undefined ? a.totalQuantity : 1), 0);

  const disposedCount = currentRole === 'Employee' 
    ? 0 
    : assets.filter(a => a.status === 'Disposed').reduce((acc, a) => acc + (a.totalQuantity !== undefined ? a.totalQuantity : 1), 0);

  const expiringAMCsCount = amcs.filter(amc => {
    const diff = new Date(amc.endDate) - new Date();
    return diff > 0 && diff < (30 * 24 * 60 * 60 * 1000);
  }).length;

  const expiringWarrantiesCount = assets.filter(a => {
    const diff = new Date(a.warrantyExpiry) - new Date();
    return diff > 0 && diff < (90 * 24 * 60 * 60 * 1000);
  }).length;

  const pendingPaymentsCount = invoices.filter(inv => inv.paymentStatus === 'Pending' || inv.paymentStatus === 'Overdue').length;

  // Filter and Sort Invoices
  const filteredInvoices = (invoices || [])
    .filter(inv => {
      if (!inv) return false;
      
      // Status Filter
      if (invoiceFilterStatus !== 'All' && inv.paymentStatus !== invoiceFilterStatus) {
        return false;
      }

      // Search query
      const query = (invoiceSearchTerm || '').toLowerCase();
      if (!query) return true;

      return (
        String(inv.id || '').toLowerCase().includes(query) ||
        String(inv.poReference || '').toLowerCase().includes(query) ||
        String(inv.vendor || '').toLowerCase().includes(query) ||
        String(inv.paymentStatus || '').toLowerCase().includes(query) ||
        String(inv.date || '').toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      let valA = a[invoiceSortField];
      let valB = b[invoiceSortField];

      if (valA === undefined || valA === null) valA = '';
      if (valB === undefined || valB === null) valB = '';

      if (invoiceSortField === 'amount' || invoiceSortField === 'gst') {
        const numA = Number(valA) || 0;
        const numB = Number(valB) || 0;
        return invoiceSortOrder === 'asc' ? numA - numB : numB - numA;
      }

      const strA = String(valA).toLowerCase();
      const strB = String(valB).toLowerCase();
      
      if (strA < strB) return invoiceSortOrder === 'asc' ? -1 : 1;
      if (strA > strB) return invoiceSortOrder === 'asc' ? 1 : -1;
      return 0;
    });

  // Paginated Invoices
  const totalInvoicePages = Math.ceil(filteredInvoices.length / invoiceItemsPerPage) || 1;
  const startIndex = (invoiceCurrentPage - 1) * invoiceItemsPerPage;
  const paginatedInvoices = filteredInvoices.slice(startIndex, startIndex + invoiceItemsPerPage);

  // Clear unread notifications
  const handleClearNotifications = async () => {
    if (isApiConnected) {
      try {
        await api.markAllNotificationsRead();
      } catch (err) {
        console.error("Failed to clear notifications in DB:", err);
      }
    }
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    addToast("Notifications Cleared", "All notifications marked read.", "info");
  };

  /* ---------------- Notification selection & deletion ---------------- */

  const toggleNotificationSelected = (id) => {
    setSelectedNotificationIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAllNotifications = () => {
    setSelectedNotificationIds(prev =>
      prev.length === notifications.length ? [] : notifications.map(n => n.id)
    );
  };

  // Re-reads from the server after a delete so the list reflects what actually
  // happened: the API only removes notifications addressed to the caller, so a
  // purely local filter could show rows as gone that are still there.
  const refreshNotifications = async () => {
    if (!isApiConnected) return null;
    try {
      const fresh = await api.getNotifications();
      setNotifications(fresh || []);
      return fresh || [];
    } catch (err) {
      console.warn('[AssetFlow] Could not refresh notifications:', err);
      return null;
    }
  };

  const handleDeleteNotification = async (notification) => {
    if (!window.confirm('Delete this notification? This cannot be undone.')) return;
    setIsDeletingNotifications(true);
    try {
      if (isApiConnected) await api.deleteNotification(notification.id);
      if (!(await refreshNotifications())) {
        setNotifications(prev => prev.filter(n => n.id !== notification.id));
      }
      setSelectedNotificationIds(prev => prev.filter(x => x !== notification.id));
      addToast("Notification Deleted", "The notification was removed.", "success");
    } catch (err) {
      addToast("Delete Failed", err.message || "Could not delete the notification.", "error");
    } finally {
      setIsDeletingNotifications(false);
    }
  };

  const handleBulkDeleteNotifications = async () => {
    const count = selectedNotificationIds.length;
    if (count === 0) return;
    if (!window.confirm(`Delete ${count} notification${count === 1 ? '' : 's'}? This cannot be undone.`)) return;

    setIsDeletingNotifications(true);
    try {
      let deleted = count;
      if (isApiConnected) {
        const res = await api.bulkDeleteNotifications(selectedNotificationIds);
        deleted = res?.deleted ?? count;
      }
      if (!(await refreshNotifications())) {
        setNotifications(prev => prev.filter(n => !selectedNotificationIds.includes(n.id)));
      }
      setSelectedNotificationIds([]);
      addToast("Notifications Deleted", `${deleted} notification${deleted === 1 ? '' : 's'} removed.`, "success");
    } catch (err) {
      addToast("Delete Failed", err.message || "Could not delete the selected notifications.", "error");
    } finally {
      setIsDeletingNotifications(false);
    }
  };


  if (activeTab === 'login') {
    return (
      <div className="login-page-wrapper">
        <div className="toast-container">
          {toasts.map(t => (
            <div key={t.id} className={`toast ${t.type}`}>
              <div className="toast-content">
                <div className="toast-title">{t.title}</div>
                <div className="toast-message">{t.message}</div>
              </div>
              <button className="icon-button" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <LoginView
          onLoginSuccess={(session) => {
            setCurrentUser(session);
            setCurrentRole(session.role);
            window.location.hash = '#/dashboard';
            setActiveTab('dashboard');
            addToast("Welcome back", `Authenticated as ${session.name}.`, "success");
          }}
        />
      </div>
    );
  }

  if (currentUser && currentUser.passwordResetRequired) {
    return (
      // Fixed to the viewport rather than laid out inside #root. #root is a row flex
      // container, so a plain min-height wrapper with no width shrank to the card and
      // pinned it to the left edge — centered vertically but not horizontally.
      // inset:0 guarantees the box is the whole viewport at every size; overflow:auto
      // lets the card scroll on short screens instead of being clipped.
      <div style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-app)',
        padding: '20px',
        overflowY: 'auto',
        color: 'var(--text-primary)',
        zIndex: 1000
      }}>
        <div className="card" style={{ maxWidth: '400px', width: '100%', padding: '32px', margin: 'auto' }}>
          <h2 style={{ margin: '0 0 10px', fontSize: '20px', fontWeight: 700 }}>Update Password Required</h2>
          <p style={{ margin: '0 0 24px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            This is your first login. For security reasons, please change your temporary password to a secure new password.
          </p>
          <form onSubmit={handleFirstLoginPasswordReset} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">New Password</label>
              <input 
                type="password" 
                className="form-input" 
                placeholder="Min. 8 characters"
                value={firstLoginPassword} 
                onChange={e => setFirstLoginPassword(e.target.value)} 
                required 
              />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm New Password</label>
              <input 
                type="password" 
                className="form-input" 
                placeholder="Repeat new password"
                value={firstLoginConfirm} 
                onChange={e => setFirstLoginConfirm(e.target.value)} 
                required 
              />
            </div>
            {firstLoginError && (
              <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#ef4444' }}>
                {firstLoginError}
              </div>
            )}
            {firstLoginSuccess && (
              <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#22c55e' }}>
                {firstLoginSuccess}
              </div>
            )}
            <SpinnerButton type="submit" className="btn btn-primary" loading={firstLoginLoading} loadingText="Updating…">Update Password</SpinnerButton>
          </form>
        </div>
      </div>
    );
  }

  // Values delivered to the extracted route pages via context (see AppDataContext).
  // App still owns this state and these handlers; the context only spares the pages a
  // long prop chain. Grows as more pages are extracted from the render below.
  const appData = {
    // shared helpers (used by most pages)
    can,
    navigate,
    addToast,
    // core data
    assets,
    invoices,
    logs,
    // dashboard counters
    totalAssetsCount,
    availableCount,
    assignedCount,
    maintenanceCount,
    disposedCount,
    pendingPaymentsCount,
    expiringWarrantiesCount,
    expiringAMCsCount,
    // qr scanner
    isScanning,
    isWebcamScanning,
    setIsWebcamScanning,
    scannerSelectedAssetId,
    setScannerSelectedAssetId,
    handleSimulateScan,
    // assets page
    assetFilterCategory,
    assetFilterDept,
    assetFilterStatus,
    bulkAssetCategoryValue,
    bulkAssetDeptValue,
    bulkAssetLocationValue,
    departments,
    filteredAssets,
    handleBulkAssetCategoryChange,
    handleBulkAssetDeptChange,
    handleBulkAssetLocationChange,
    handleBulkAssetStatusChange,
    handleBulkDeleteAssets,
    handleDeleteAsset,
    handleDisposeAsset,
    hasPermission,
    selectedAssetIds,
    setAddAssetModal,
    setAllocateModal,
    setAssetDetailModal,
    setAssetFilterCategory,
    setAssetFilterDept,
    setAssetFilterStatus,
    setBulkAssetCategoryValue,
    setBulkAssetDeptValue,
    setBulkAssetLocationValue,
    setEditAssetModal,
    setQrStickerModal,
    setReturnModal,
    setSelectedAssetIds,
    setShowBulkAssetCategory,
    setShowBulkAssetDept,
    setShowBulkAssetLocation,
    setShowBulkImportAssets,
    setTransferModal,
    showBulkAssetCategory,
    showBulkAssetDept,
    showBulkAssetLocation,
    // allocations page
    assignments,
    movements,
    quickAllocAssetId,
    quickTransferAssetId,
    setEditAssignmentModal,
    setQuickAllocAssetId,
    setQuickTransferAssetId,
    setReturnAssignmentModal,
    setShowEmployeeLookup,
    showEmployeeLookup,
    // amc page
    addingAmc,
    addingServiceRecord,
    amcSearch,
    amcs,
    filteredAmcs,
    handleAddAMC,
    handleAddAMCServiceRecord,
    handleMapAssetToAmc,
    mapAmcId,
    mapAssetId,
    mappingAmcAsset,
    newAmcServiceSchedule,
    setAmcSearch,
    setMapAmcId,
    setMapAssetId,
    setNewAmcServiceSchedule,
    // reports page
    generatedReport,
    handleExportCSV,
    handleExportExcel,
    handleExportPDF,
    reportType,
    reportsView,
    setReportType,
    setReportsView,
    // documents page
    documents,
    handleUploadDocument,
    newDocCategory,
    setNewDocCategory,
    uploadingDocument,
  };

  return (
    <AppDataProvider value={appData}>
    <div className="app-container">
      {/* Toast Alert Drawer */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <div className="toast-content">
              <div className="toast-title">{t.title}</div>
              <div className="toast-message">{t.message}</div>
            </div>
            <button className="icon-button" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Sidebar Menu Drawer */}
      {mobileNavOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside id="app-sidebar" className={`sidebar ${mobileNavOpen ? 'is-open' : ''}`}>
        <div className="logo-section">
          <div className="logo-icon">AF</div>
          <span className="logo-text">AssetFlow</span>
        </div>

        <nav className="nav-links">
          {/* Every nav item is gated by that module's view permission. The matrix,
              not a hardcoded role string, decides what a role sees. */}
          {can('dashboard', 'view') && (
            <button onClick={() => navigate('dashboard')} className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}>
              <LayoutDashboard className="nav-icon" />
              Dashboard
            </button>
          )}

          {can('assets', 'view') && (
            <button onClick={() => navigate('assets')} className={`nav-item ${activeTab === 'assets' ? 'active' : ''}`}>
              <Package className="nav-icon" />
              Asset Directory
            </button>
          )}

          {can('allocations', 'view') && (
            <button onClick={() => navigate('allocations')} className={`nav-item ${activeTab === 'allocations' ? 'active' : ''}`}>
              <UserCheck className="nav-icon" />
              Allocations & Movements
            </button>
          )}

          {can('amc', 'view') && (
            <button onClick={() => navigate('amc')} className={`nav-item ${activeTab === 'amc' ? 'active' : ''}`}>
              <RefreshCw className="nav-icon" />
              AMC Contracts
            </button>
          )}

          {can('finance', 'view') && (
            <button onClick={() => navigate('finance')} className={`nav-item ${activeTab === 'finance' ? 'active' : ''}`}>
              <FileText className="nav-icon" />
              Finance & Invoices
            </button>
          )}

          {can('documents', 'view') && (
            <button onClick={() => navigate('documents')} className={`nav-item ${activeTab === 'documents' ? 'active' : ''}`}>
              <FolderOpen className="nav-icon" />
              Document Repository
            </button>
          )}

          {can('qr', 'view') && (
            <button onClick={() => navigate('qr_lookup')} className={`nav-item ${activeTab === 'qr_lookup' ? 'active' : ''}`}>
              <QrCode className="nav-icon" />
              QR Stickers & Scan
            </button>
          )}

          {can('reports', 'view') && (
            <button onClick={() => navigate('reports')} className={`nav-item ${activeTab === 'reports' ? 'active' : ''}`}>
              <ClipboardList className="nav-icon" />
              Reports & Logs
            </button>
          )}

          {can('emails', 'view') && (
            <button onClick={() => navigate('emails')} className={`nav-item ${activeTab === 'emails' ? 'active' : ''}`}>
              <Mail className="nav-icon" />
              Email Alerts Inbox
            </button>
          )}

          {can('tickets', 'view') && (
            <button onClick={() => navigate('tickets')} className={`nav-item ${activeTab === 'tickets' ? 'active' : ''}`}>
              <ClipboardList className="nav-icon" />
              Support Tickets
            </button>
          )}

          {can('sla', 'view') && (
            <button onClick={() => navigate('sla')} className={`nav-item ${activeTab === 'sla' ? 'active' : ''}`}>
              <ShieldCheck className="nav-icon" />
              SLA Management
            </button>
          )}

          {can('knowledge', 'view') && (
            <button onClick={() => navigate('knowledge_base')} className={`nav-item ${activeTab === 'knowledge_base' ? 'active' : ''}`}>
              <BookOpen className="nav-icon" />
              Knowledge Base
            </button>
          )}

          {can('userDirectory', 'view') && (
            <button onClick={() => navigate('users')} className={`nav-item ${activeTab === 'users' ? 'active' : ''}`}>
              <Users className="nav-icon" />
              User Directory
            </button>
          )}
        </nav>

        {/* User profile details bottom element */}
        <div className="user-profile-section">
          <div className="user-profile" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, cursor: 'pointer' }} onClick={() => setShowProfileModal(true)}>
              <div className="avatar">
                {currentUser ? currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase() : (currentRole === 'Employee' ? 'AJ' : currentRole.substring(0, 2).toUpperCase())}
              </div>
              <div className="user-info" style={{ minWidth: 0 }}>
                <div className="user-name" title={currentUser ? currentUser.name : (currentRole === 'Employee' ? 'Alice Johnson' : 'Admin Operations')}>
                  {currentUser ? currentUser.name : (currentRole === 'Employee' ? 'Alice Johnson' : 'Admin Operations')}
                </div>
                <div className="user-role-badge">{currentRole}</div>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="icon-button logout-btn"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Panel Viewport */}
      <main className="main-content">
        {/* Header toolbar */}
        <header className="top-header">
          <button
            type="button"
            className="mobile-nav-toggle"
            onClick={() => setMobileNavOpen((open) => !open)}
            aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileNavOpen}
            aria-controls="app-sidebar"
          >
            <Menu size={18} />
          </button>

          <div className="header-left">
            <div className="search-bar-container">
              <Search className="search-icon" />
              <input
                type="text"
                placeholder="Search the register — asset ID, serial, employee, department…"
                className="search-bar"
                value={searchQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setSearchQuery(val);
                  if (val && activeTab !== 'assets') {
                    navigate('assets');
                  }
                }}
              />
            </div>
          </div>

          <div className="header-right">
            {/* Dark Light Theme Toggle */}
            <button
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="Toggle Theme"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {/* Notification bell */}
            <div style={{ position: 'relative' }}>
              <button ref={notifBellRef} className="icon-button" onClick={() => setShowNotifications(!showNotifications)}>
                <Bell size={18} />
                {notifications.filter(n => !n.read).length > 0 && (
                  <span className="badge-count">{notifications.filter(n => !n.read).length}</span>
                )}
              </button>

              {showNotifications && createPortal(
                <div
                  ref={notifPopoverRef}
                  className="notif-popover"
                  style={notifPopoverStyle || { position: 'fixed', visibility: 'hidden' }}
                >
                  <div className="notif-header">
                    <span className="notif-title">System Alerts</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {notifications.length > 0 && (
                        <button className="notif-clear-btn" onClick={toggleSelectAllNotifications}>
                          {selectedNotificationIds.length === notifications.length ? 'Deselect all' : 'Select all'}
                        </button>
                      )}
                      <SpinnerButton className="notif-clear-btn" onClick={handleClearNotifications} loadingText="Marking…">Mark all read</SpinnerButton>
                    </div>
                  </div>

                  {selectedNotificationIds.length > 0 && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: '10px', padding: '8px 14px', background: 'var(--primary-soft)',
                      borderBottom: '1px solid var(--border-color)'
                    }}>
                      <span style={{ fontSize: '12px', fontWeight: 600 }}>
                        {selectedNotificationIds.length} selected
                      </span>
                      <button
                        className="btn btn-danger btn-sm" onClick={handleBulkDeleteNotifications} disabled={isDeletingNotifications}
                      >
                        <Trash2 size={12} /> Delete selected
                      </button>
                    </div>
                  )}

                  <div className="notif-body">
                    {notifications.length === 0 ? (
                      <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        No new notifications.
                      </div>
                    ) : (
                      notifications.map(n => (
                        <div key={n.id} className={`notif-item ${!n.read ? 'unread' : ''}`}>
                          <input
                            type="checkbox"
                            aria-label={`Select notification: ${n.text}`}
                            checked={selectedNotificationIds.includes(n.id)}
                            onChange={() => toggleNotificationSelected(n.id)}
                            style={{ marginTop: '4px', flexShrink: 0 }}
                          />
                          <div className={`notif-dot-active`} style={{ backgroundColor: n.type === 'error' ? 'var(--status-disposed)' : n.type === 'warning' ? 'var(--status-maintenance)' : 'var(--primary)' }}></div>
                          <div className="notif-details" style={{ flexGrow: 1 }}>
                            <span className="notif-text">{n.text}</span>
                            <RelativeTime className="notif-time" value={n.createdAt} />
                          </div>
                          <SpinnerButton
                            className="btn-table-action delete"
                            title="Delete notification"
                            aria-label="Delete notification"
                            onClick={() => handleDeleteNotification(n)}
                            disabled={isDeletingNotifications}
                            icon={Trash2}
                            spinnerSize={13}
                            style={{ flexShrink: 0 }}
                          />
                        </div>
                      ))
                    )}
                  </div>
                </div>,
                document.body
              )}
            </div>

          </div>
        </header>

        {/* Dynamic Pages Area */}
        <div className="page-container">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              {...silk.entrance}
              style={{ width: '100%' }}
            >
            <AsyncBoundary
              status={dataStatus}
              error={loadError}
              onRetry={retryInitialLoad}
              skeleton={<PageSkeleton />}
            >
            {/* Suspense boundary for the lazily-loaded page components below. */}
            <Suspense fallback={<PageSkeleton />}>
            {activePageDenied ? (
              <div className="empty-state" role="alert" style={{ minHeight: '320px' }}>
                <div className="empty-state-icon" style={{ color: 'var(--status-disposed)' }}>
                  <AlertTriangle size={30} />
                </div>
                <div className="empty-state-title">Access restricted</div>
                <div className="empty-state-desc">
                  Your role ({roleLabel(currentRole)}) does not have permission to view this section.
                  Contact a Super Administrator if you believe this is a mistake.
                </div>
              </div>
            ) : (
            <>
          
          {/* ==================== DASHBOARD PANEL ==================== */}
          {activeTab === 'dashboard' && <DashboardPage />}

          {/* ==================== ASSET INVENTORY ==================== */}
          {activeTab === 'assets' && <AssetsPage />}

          {/* ==================== ALLOCATIONS & MOVEMENTS ==================== */}
          {activeTab === 'allocations' && <AllocationsPage />}

          {/* ==================== AMC MANAGEMENT ==================== */}
          {activeTab === 'amc' && <AmcPage />}

                              {/* ==================== FINANCE & INVOICES ==================== */}
          {activeTab === 'finance' && (
            <>
              <div className="page-header">
                <div className="page-title-section">
                  <span className="page-kicker">Financial Ledger</span>
                  <h1 className="page-title">Procurement, Invoices & Finance</h1>
                  <span className="page-subtitle">Map equipment purchases, tax calculations, and process vendor settlements</span>
                </div>
              </div>

              {/* Finance Sub-Tabs */}
              <div className="tabs-container" style={{ marginBottom: '24px', display: 'flex', gap: '8px' }}>
                <button 
                  className={`tab-btn ${financeSubTab === 'all' ? 'active' : ''}`} 
                  onClick={() => { setFinanceSubTab('all'); setSelectedInvoiceIds([]); }}
                >
                  📁 All Invoices ({invoices.length})
                </button>
                <button
                  className={`tab-btn ${financeSubTab === 'purchase_orders' ? 'active' : ''}`}
                  onClick={() => { setFinanceSubTab('purchase_orders'); setSelectedInvoiceIds([]); }}
                >
                  🧾 Purchase Orders
                </button>
                <button 
                  className={`tab-btn ${financeSubTab === 'pending_upload' ? 'active' : ''}`} 
                  onClick={() => { setFinanceSubTab('pending_upload'); setSelectedInvoiceIds([]); }}
                >
                  ⚠️ Pending Scan Uploads ({invoices.filter(i => !i.fileName || i.fileName === 'None' || i.fileName === 'invoice.pdf').length})
                </button>
                <button 
                  className={`tab-btn ${financeSubTab === 'asset_mapping' ? 'active' : ''}`} 
                  onClick={() => { setFinanceSubTab('asset_mapping'); setSelectedInvoiceIds([]); }}
                >
                  🔗 Bidirectional Asset Mapping
                </button>
              </div>

              {financeSubTab === 'purchase_orders' && (
                <PurchaseOrdersPage
                  canManage={can('finance', 'create')}
                  can={can}
                  invoices={invoices}
                  amcs={amcs}
                  addToast={addToast}
                />
              )}

              {isInitialLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '300px', gap: '16px', color: 'var(--primary)' }}>
                  <RefreshCw className="animate-spin" size={36} />
                  <span style={{ fontWeight: '600', fontSize: '15px' }}>Loading purchase invoices & ledger data...</span>
                </div>
              ) : (
                <>
                  {financeSubTab === 'all' && (
                    <>
                      <div className="dashboard-grid-secondary">
                        {/* Upload Invoice Form */}
                        <div className="card">
                          <span className="card-title">Record Vendor Purchase Invoice</span>
                          {hasPermission('finance') ? (
                            <form onSubmit={handleAddInvoice} className="form-grid">
                              <div className="form-group">
                                <label className="form-label">Purchase Order Ref</label>
                                <input type="text" name="poReference" placeholder="e.g. PO-2026-99" className="form-input" required />
                              </div>
                              <div className="form-group">
                                <label className="form-label">Vendor Business Name</label>
                                <input type="text" name="vendor" placeholder="e.g. Dell Commercial Sales" className="form-input" required />
                              </div>
                              <div className="form-group">
                                <label className="form-label">Base Invoice Cost (₹)</label>
                                <input type="number" name="amount" placeholder="e.g. 5000" className="form-input" required />
                              </div>
                              <div className="form-group">
                                <label className="form-label">GST / Tax Percentage (%)</label>
                                <input type="number" name="gst" placeholder="e.g. 18" className="form-input" required />
                              </div>
                              <div className="form-group">
                                <label className="form-label">Invoice Issue Date</label>
                                <input type="date" name="date" className="form-input" required />
                              </div>
                              <div className="form-group">
                                <label className="form-label">PDF Invoice Scan File (Optional)</label>
                                <input type="file" name="fileName" className="form-input" />
                              </div>
                              <div className="form-group full-width">
                                <label className="form-label">Link Asset IDs (comma-separated, e.g. AST-101, AST-102)</label>
                                <input type="text" name="linkAssetIds" placeholder="e.g. AST-201, AST-202" className="form-input" />
                              </div>
                              <div className="form-group full-width" style={{ marginTop: '8px' }}>
                                <SpinnerButton type="submit" className="btn btn-primary" style={{ width: '100%' }} loading={addingInvoice} loadingText="Filing…">Record &amp; File Purchase Invoice</SpinnerButton>
                              </div>
                            </form>
                          ) : (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', padding: '24px' }}>
                              Finance Team credentials are required to file new acquisition invoices.
                            </div>
                          )}
                        </div>

                        <div className="card">
                          <span className="card-title">Tax and Procurement summary</span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                              <span>Total Procurement Spend:</span>
                              <span style={{ fontWeight: '700' }}>
                                {formatINR(invoices.reduce((acc, curr) => acc + Number(curr.amount || 0) + (Number(curr.amount || 0) * (Number(curr.gst || 0) / 100)), 0))}
                              </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                              <span>Pending Settlements:</span>
                              <span style={{ fontWeight: '700', color: 'var(--status-maintenance)' }}>
                                {formatINR(invoices.filter(i => i.paymentStatus !== 'Paid').reduce((acc, curr) => acc + Number(curr.amount || 0) + (Number(curr.amount || 0) * (Number(curr.gst || 0) / 100)), 0))}
                              </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                              <span>Estimated Accrued Taxes (GST):</span>
                              <span style={{ fontWeight: '700', color: 'var(--primary)' }}>
                                {formatINR(invoices.reduce((acc, curr) => acc + (Number(curr.amount || 0) * (Number(curr.gst || 0) / 100)), 0))}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {invoices.length === 0 ? (
                        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', textAlign: 'center', gap: '16px', marginTop: '20px' }}>
                          <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(99, 44, 237, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', color: 'var(--primary)' }}>
                            📄
                          </div>
                          <div>
                            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 6px' }}>No Purchase Invoices Filed</h3>
                            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '400px', margin: 0 }}>
                              Procurement scan records, GST settlements, and billing links will appear here once recorded.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* Search and Action Toolbar */}
                          <div className="card" style={{ padding: '16px', margin: '20px 0 16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', gap: '12px', flexGrow: 1, minWidth: 'min(280px, 100%)', flexWrap: 'wrap', alignItems: 'center' }}>
                              {/* Search */}
                              <div className="search-field" style={{ width: 'min(250px, 100%)' }}>
                                <Search size={16} className="search-field-icon" />
                                <input
                                  type="text"
                                  placeholder="Search invoices..."
                                  className="form-input"
                                  value={invoiceSearchTerm}
                                  onChange={e => { setInvoiceSearchTerm(e.target.value); setInvoiceCurrentPage(1); }}

                                />
                              </div>
                              
                              {/* Filter Status */}
                              <div style={{ width: '160px' }}>
                                <CustomSelect
                                  options={[
                                    { value: 'All', label: '📊 Status: All' },
                                    { value: 'Pending', label: 'Pending' },
                                    { value: 'Partially Paid', label: 'Partially Paid' },
                                    { value: 'Paid', label: 'Paid' },
                                    { value: 'Overdue', label: 'Overdue' }
                                  ]}
                                  value={invoiceFilterStatus}
                                  onChange={e => { setInvoiceFilterStatus(e.target.value); setInvoiceCurrentPage(1); }}
                                />
                              </div>

                              {/* Sort Field */}
                              <div style={{ width: '160px' }}>
                                <CustomSelect
                                  options={[
                                    { value: 'id', label: '🔀 Sort: ID' },
                                    { value: 'date', label: 'Sort: Issue Date' },
                                    { value: 'amount', label: 'Sort: Base Value' },
                                    { value: 'vendor', label: 'Sort: Vendor' },
                                    { value: 'poReference', label: 'Sort: PO Ref' }
                                  ]}
                                  value={invoiceSortField}
                                  onChange={e => setInvoiceSortField(e.target.value)}
                                />
                              </div>

                              {/* Sort Order Button */}
                              <button 
                                className="btn btn-secondary"
                                onClick={() => setInvoiceSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                                style={{ height: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '80px', padding: '0 12px' }}
                                title="Toggle Sort Order"
                                type="button"
                              >
                                {invoiceSortOrder === 'asc' ? '↑ Asc' : '↓ Desc'}
                              </button>
                            </div>

                            <div className="action-row">
                              <button className="btn btn-secondary" onClick={() => setShowBulkImportInvoices(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <FileUp size={14} />
                                Bulk Import Invoices
                              </button>
                              <button className="btn btn-secondary" onClick={handleBulkExportInvoices} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <Download size={14} />
                                Export Invoices
                              </button>
                            </div>
                          </div>

                          {/* Bulk Actions Bar */}
                          {selectedInvoiceIds.length > 0 && (
                            <div className="card" style={{ padding: '12px 20px', marginBottom: '16px', backgroundColor: 'rgba(99, 44, 237, 0.05)', border: '1.5px solid var(--primary)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                              <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--primary)' }}>
                                ⚡ {selectedInvoiceIds.length} Invoice{selectedInvoiceIds.length > 1 ? 's' : ''} Selected
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Update Status:</span>
                                  <CustomSelect
                                    options={['Pending', 'Partially Paid', 'Paid', 'Overdue'].map(s => ({ value: s, label: s }))}
                                    placeholder="Change Status"
                                    onChange={e => handleBulkInvoiceStatusChange(e.target.value)}
                                    style={{ width: '150px' }}
                                  />
                                </div>
                                <button className="btn btn-secondary" onClick={handleBulkExportInvoices} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <Download size={14} />
                                  Export Selected
                                </button>
                                <SpinnerButton className="btn btn-primary" style={{ backgroundColor: 'var(--status-disposed)' }} onClick={handleBulkDeleteInvoices} loadingText="Deleting…">Delete Selected</SpinnerButton>
                              </div>
                            </div>
                          )}

                          {/* Invoices List */}
                          <div className="table-container">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th style={{ width: '40px' }}>
                                    <input 
                                      type="checkbox"
                                      checked={paginatedInvoices.length > 0 && paginatedInvoices.every(i => selectedInvoiceIds.includes(i.id))}
                                      onChange={e => {
                                        if (e.target.checked) {
                                          const visibleIds = paginatedInvoices.map(i => i.id);
                                          setSelectedInvoiceIds(prev => Array.from(new Set([...prev, ...visibleIds])));
                                        } else {
                                          const visibleIds = paginatedInvoices.map(i => i.id);
                                          setSelectedInvoiceIds(prev => prev.filter(id => !visibleIds.includes(id)));
                                        }
                                      }}
                                    />
                                  </th>
                                  <th>Invoice ID</th>
                                  <th>PO Reference</th>
                                  <th>Vendor Partner</th>
                                  <th>Date</th>
                                  <th>Base Value</th>
                                  <th>GST (%)</th>
                                  <th>Total Cost</th>
                                  <th>Associated Assets</th>
                                  <th>Payment Status</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {paginatedInvoices.length === 0 ? (
                                  <tr>
                                    <td colSpan="11" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                                      No invoices match your search/filter criteria.
                                    </td>
                                  </tr>
                                ) : (
                                  paginatedInvoices.map(inv => {
                                    const amountNum = Number(inv.amount || 0);
                                    const gstNum = Number(inv.gst || 0);
                                    const total = amountNum + (amountNum * (gstNum / 100));
                                    const isSelected = selectedInvoiceIds.includes(inv.id);
                                    const hasPdf = inv.fileName && inv.fileName !== 'None' && inv.fileName !== 'invoice.pdf';
                                    return (
                                      <tr key={inv.id} className={isSelected ? 'selected-row' : ''}>
                                        <td>
                                          <input 
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => {
                                              setSelectedInvoiceIds(prev => 
                                                prev.includes(inv.id) ? prev.filter(id => id !== inv.id) : [...prev, inv.id]
                                              );
                                            }}
                                          />
                                        </td>
                                        <td 
                                          onClick={() => setInvoiceDetailModal(inv)}
                                          style={{ fontFamily: 'var(--mono)', fontSize: '11px', fontWeight: '700', color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}
                                        >
                                          {inv.id}
                                        </td>
                                        <td style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>{inv.poReference}</td>
                                        <td style={{ fontWeight: '600' }}>{inv.vendor}</td>
                                        <td style={{ fontSize: '12px' }}>{inv.date}</td>
                                        <td>{formatINR(amountNum)}</td>
                                        <td>{inv.gst}%</td>
                                        <td style={{ fontWeight: '700' }}>{formatINR(total)}</td>
                                        <td style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                          {(inv.mappedAssets || []).length > 0 ? (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                              {(inv.mappedAssets || []).map(aid => (
                                                <span 
                                                  key={aid}
                                                  onClick={() => {
                                                    const assetObj = assets.find(a => a.id === aid);
                                                    if (assetObj) setAssetDetailModal(assetObj);
                                                  }}
                                                  style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline', fontWeight: '500' }}
                                                >
                                                  {aid}
                                                </span>
                                              ))}
                                            </div>
                                          ) : (
                                            'No mapped assets'
                                          )}
                                        </td>
                                        <td>
                                          <span className="badge" style={{
                                            backgroundColor: inv.paymentStatus === 'Paid' ? 'var(--status-available-bg)' : inv.paymentStatus === 'Pending' ? 'var(--status-maintenance-bg)' : inv.paymentStatus === 'Overdue' ? 'var(--status-disposed-bg)' : 'var(--status-assigned-bg)',
                                            color: inv.paymentStatus === 'Paid' ? 'var(--status-available)' : inv.paymentStatus === 'Pending' ? 'var(--status-maintenance)' : inv.paymentStatus === 'Overdue' ? 'var(--status-disposed)' : 'var(--status-assigned)'
                                          }}>
                                            {inv.paymentStatus}
                                          </span>
                                        </td>
                                        <td>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            {hasPermission('finance') ? (
                                              <CustomSelect
                                                options={['Pending', 'Partially Paid', 'Paid', 'Overdue'].map(s => ({ value: s, label: s }))}
                                                value={inv.paymentStatus}
                                                onChange={(e) => handleInvoicePaymentStatus(inv.id, e.target.value)}
                                                style={{ width: '130px' }}
                                              />
                                            ) : (
                                              <span style={{ fontSize: '11px', fontStyle: 'italic', color: 'var(--text-muted)' }}>Authorized only</span>
                                            )}
                                            {hasPdf ? (
                                              <a 
                                                href={`/api/files/${inv.fileName}`} 
                                                target="_blank" 
                                                rel="noopener noreferrer" 
                                                className="btn btn-secondary btn-sm" 
                                                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px'}}
                                              >
                                                📄 PDF
                                              </a>
                                            ) : (
                                              <span 
                                                style={{ 
                                                  display: 'inline-flex', 
                                                  alignItems: 'center', 
                                                  gap: '4px', 
                                                  padding: '4px 8px', 
                                                  fontSize: '11px', 
                                                  borderRadius: '4px', 
                                                  background: 'rgba(220, 38, 38, 0.1)', 
                                                  color: '#dc2626', 
                                                  fontWeight: '600',
                                                  border: '1px dashed rgba(220, 38, 38, 0.3)'
                                                }}
                                              >
                                                ⚠️ No PDF
                                              </span>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })
                                )}
                              </tbody>
                            </table>
                          </div>

                          {/* Pagination Controls */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', padding: '0 4px', fontSize: '13px' }}>
                            <div style={{ color: 'var(--text-secondary)' }}>
                              Showing {filteredInvoices.length === 0 ? 0 : startIndex + 1}-{Math.min(startIndex + invoiceItemsPerPage, filteredInvoices.length)} of {filteredInvoices.length} invoices
                            </div>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <button 
                                className="btn btn-secondary btn-sm" disabled={invoiceCurrentPage === 1} onClick={() => setInvoiceCurrentPage(prev => Math.max(1, prev - 1))} type="button"
                              >
                                Previous
                              </button>
                              <span style={{ margin: '0 8px', fontWeight: '600' }}>
                                Page {invoiceCurrentPage} of {totalInvoicePages}
                              </span>
                              <button 
                                className="btn btn-secondary btn-sm" disabled={invoiceCurrentPage === totalInvoicePages} onClick={() => setInvoiceCurrentPage(prev => Math.min(totalInvoicePages, prev + 1))} type="button"
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}

                  {financeSubTab === 'pending_upload' && (
                    <>
                      <div className="card" style={{ padding: '16px', marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div className="search-field" style={{ display: 'flex', gap: '12px', flexGrow: 1, minWidth: 'min(280px, 100%)', maxWidth: '500px' }}>
                          <Search size={16} className="search-field-icon" />
                          <input
                            type="text"
                            placeholder="Search pending uploads by ID, PO or vendor..."
                            className="form-input"
                            value={invoicePdfSearchTerm}
                            onChange={e => setInvoicePdfSearchTerm(e.target.value)}

                          />
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
                        {invoices.filter(inv => {
                          const isPending = !inv.fileName || inv.fileName === 'None' || inv.fileName === 'invoice.pdf';
                          if (!isPending) return false;
                          const term = invoicePdfSearchTerm.toLowerCase();
                          return (
                            String(inv.id).toLowerCase().includes(term) ||
                            String(inv.vendor).toLowerCase().includes(term) ||
                            String(inv.poReference).toLowerCase().includes(term)
                          );
                        }).length === 0 ? (
                          <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                            🎉 All invoices have verified PDF scans uploaded. No pending uploads!
                          </div>
                        ) : (
                          invoices.filter(inv => {
                            const isPending = !inv.fileName || inv.fileName === 'None' || inv.fileName === 'invoice.pdf';
                            if (!isPending) return false;
                            const term = invoicePdfSearchTerm.toLowerCase();
                            return (
                              String(inv.id).toLowerCase().includes(term) ||
                              String(inv.vendor).toLowerCase().includes(term) ||
                              String(inv.poReference).toLowerCase().includes(term)
                            );
                          }).map(inv => {
                            const amountNum = Number(inv.amount || 0);
                            const gstNum = Number(inv.gst || 0);
                            const total = amountNum + (amountNum * (gstNum / 100));
                            return (
                              <div key={inv.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '20px', borderLeft: '4px solid var(--status-maintenance)' }}>
                                <div style={{ flex: '1 1 300px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                    <span 
                                      onClick={() => setInvoiceDetailModal(inv)}
                                      style={{ fontFamily: 'var(--mono)', fontWeight: '700', fontSize: '15px', color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}
                                    >
                                      {inv.id}
                                    </span>
                                    <span className="badge" style={{ backgroundColor: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}>PO: {inv.poReference}</span>
                                  </div>
                                  <div style={{ fontSize: '13px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px' }}>
                                    <div><strong>Vendor Partner:</strong> {inv.vendor}</div>
                                    <div><strong>Issue Date:</strong> {inv.date}</div>
                                    <div><strong>Total Bill:</strong> {formatINR(total)}</div>
                                    <div><strong>GST Tax:</strong> {inv.gst}%</div>
                                  </div>
                                </div>
                                <div 
                                  style={{ 
                                    border: '2px dashed var(--border-color)', 
                                    borderRadius: 'var(--radius-lg)', 
                                    padding: '16px 24px', 
                                    background: 'var(--bg-sidebar)', 
                                    textAlign: 'center', 
                                    position: 'relative', 
                                    minWidth: 'min(280px, 100%)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: '6px'
                                  }}
                                  onDragOver={e => e.preventDefault()}
                                  onDrop={e => {
                                    e.preventDefault();
                                    const file = e.dataTransfer?.files[0];
                                    if (file) handleUploadPdfForInvoice(inv.id, file);
                                  }}
                                >
                                  <FileUp size={24} style={{ color: 'var(--primary)' }} />
                                  <span style={{ fontSize: '12px', fontWeight: '600' }}>Drag & Drop PDF scan here</span>
                                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>or click to choose</span>
                                  <input 
                                    type="file" 
                                    accept=".pdf" 
                                    onChange={e => {
                                      const file = e.target.files?.[0];
                                      if (file) handleUploadPdfForInvoice(inv.id, file);
                                    }} 
                                    style={{ opacity: 0, position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', cursor: 'pointer' }}
                                  />
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}

                  {financeSubTab === 'asset_mapping' && (
                    <div className="dashboard-grid-secondary" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                      <div className="card">
                        <span className="card-title">Link Assets to Invoice</span>
                        {hasPermission('finance') ? (
                          <form onSubmit={(e) => {
                            e.preventDefault();
                            const invId = mappingInvoiceId;
                            if (!invId) {
                              addToast("Error", "Please select an invoice.", "error");
                              return;
                            }
                            handleBulkMapAssetsToInvoice(invId, selectedMappingAssets.join(','));
                          }} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div className="form-group">
                              <label className="form-label">Select Target Invoice</label>
                              <CustomSelect
                                options={[
                                  { value: '', label: 'Select an invoice...' },
                                  ...invoices.map(inv => ({ value: inv.id, label: `${inv.id} - ${inv.vendor} (PO: ${inv.poReference})` }))
                                ]}
                                value={mappingInvoiceId}
                                onChange={e => setMappingInvoiceId(e.target.value)}
                                required
                              />
                            </div>
                            
                            <div className="form-group">
                              <label className="form-label">Asset Picker (Select Assets to Link)</label>
                              
                              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                <input 
                                  type="text" 
                                  placeholder="Search assets by ID or name..." 
                                  value={mappingAssetSearch}
                                  onChange={e => setMappingAssetSearch(e.target.value)}
                                  className="form-input form-input-sm"
                                  style={{ flexGrow: 1, height: '36px'}}
                                />
                                <CustomSelect
                                  options={[
                                    { value: 'All', label: 'All Categories' },
                                    { value: 'IT', label: 'IT' },
                                    { value: 'Office', label: 'Office' }
                                  ]}
                                  value={mappingAssetCategory}
                                  onChange={e => setMappingAssetCategory(e.target.value)}
                                  style={{ width: '130px', height: '36px' }}
                                />
                              </div>

                              <div style={{ 
                                maxHeight: '180px', 
                                overflowY: 'auto', 
                                border: '1px solid var(--border-color)', 
                                borderRadius: '6px', 
                                padding: '8px',
                                background: 'var(--bg-sidebar)'
                              }}>
                                {assets
                                  .filter(asset => {
                                    const term = mappingAssetSearch.toLowerCase();
                                    const matchSearch = asset.id.toLowerCase().includes(term) || asset.name.toLowerCase().includes(term);
                                    const matchCategory = mappingAssetCategory === 'All' || asset.category === mappingAssetCategory;
                                    return matchSearch && matchCategory;
                                  })
                                  .map(asset => {
                                    const isChecked = selectedMappingAssets.includes(asset.id);
                                    const isLinkedElsewhere = asset.invoiceId && asset.invoiceId !== mappingInvoiceId;
                                    return (
                                      <label 
                                        key={asset.id} 
                                        style={{ 
                                          display: 'flex', 
                                          alignItems: 'center', 
                                          padding: '6px 8px', 
                                          borderRadius: '4px', 
                                          cursor: 'pointer',
                                          fontSize: '12px',
                                          background: isChecked ? 'rgba(99, 44, 237, 0.05)' : 'transparent',
                                          justifyContent: 'space-between',
                                          transition: 'background 0.2s'
                                        }}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                          <input 
                                            type="checkbox" 
                                            checked={isChecked}
                                            onChange={() => {
                                              if (isChecked) {
                                                setSelectedMappingAssets(prev => prev.filter(id => id !== asset.id));
                                              } else {
                                                setSelectedMappingAssets(prev => [...prev, asset.id]);
                                              }
                                            }}
                                          />
                                          <span style={{ fontWeight: '600' }}>{asset.id}</span>
                                          <span style={{ color: 'var(--text-secondary)' }}>- {asset.name}</span>
                                        </div>
                                        {isLinkedElsewhere && (
                                          <span style={{ fontSize: '10px', color: 'var(--status-maintenance)', fontStyle: 'italic', fontWeight: '500' }}>
                                            (linked: {asset.invoiceId})
                                          </span>
                                        )}
                                      </label>
                                    );
                                  })
                                }
                              </div>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                                {selectedMappingAssets.length === 0
                                  ? 'No assets selected — saving will unlink every asset from this invoice.'
                                  : `${selectedMappingAssets.length} asset(s) will be linked to this invoice. Unchecking removes a link.`}
                              </span>
                            </div>

                            <SpinnerButton type="submit" className="btn btn-primary" style={{ marginTop: '8px' }} disabled={!mappingInvoiceId} loading={mappingInvoiceAssets} loadingText="Saving…">Save Asset Mapping</SpinnerButton>
                          </form>
                        ) : (
                          <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', padding: '24px' }}>
                            Only the Finance Team or Super Admins can map assets to invoices.
                          </div>
                        )}
                      </div>

                      <div className="card">
                        <span className="card-title">Assets Linking Status Directory</span>
                        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
                          Review current mapping links of inventory assets to vendor purchase invoices.
                        </p>
                        <div style={{ maxHeight: '350px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                            <thead>
                              <tr style={{ background: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                <th style={{ padding: '8px 12px' }}>Asset ID</th>
                                <th style={{ padding: '8px 12px' }}>Asset Name</th>
                                <th style={{ padding: '8px 12px' }}>Linked Invoice ID</th>
                              </tr>
                            </thead>
                            <tbody>
                              {assets.length === 0 ? (
                                <tr>
                                  <td colSpan="3" style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>No assets in inventory</td>
                                </tr>
                              ) : (
                                assets.map(asset => (
                                  <tr key={asset.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '8px 12px', fontWeight: '700' }}>{asset.id}</td>
                                    <td style={{ padding: '8px 12px' }}>{asset.name}</td>
                                    <td style={{ padding: '8px 12px', color: asset.invoiceId ? 'var(--primary)' : 'var(--text-muted)', fontWeight: asset.invoiceId ? '600' : 'normal' }}>
                                      {asset.invoiceId || 'Not linked'}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}{/* ==================== DOCUMENT REPOSITORY ==================== */}
          {activeTab === 'documents' && !hasPermission('viewDocuments') && (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state-icon"><FolderOpen size={22} /></div>
                <div className="empty-state-title">Access restricted</div>
                <div className="empty-state-desc">
                  Your role ({currentRole}) is not permitted to view the Document Repository.
                  Contact an administrator if you need access.
                </div>
              </div>
            </div>
          )}
          {activeTab === 'documents' && hasPermission('viewDocuments') && <DocumentsPage />}

          {/* ==================== QR STICKERS & SCAN LOOKUP ==================== */}
          {activeTab === 'qr_lookup' && <QrLookupPage />}

          {/* ==================== REPORTS & AUDIT TRAIL ==================== */}
          {activeTab === 'reports' && <ReportsPage />}

          {/* ==================== MOCK EMAILS INBOX ==================== */}
          {activeTab === 'emails' && (
            <EmailInboxModule
              emails={emails}
              setEmails={setEmails}
              selectedEmailId={selectedEmailId}
              setSelectedEmailId={setSelectedEmailId}
              notifications={notifications}
              setNotifications={setNotifications}
              canManageNotifications={can('notificationSettings', 'manage')}
              addToast={addToast}
              isApiConnected={isApiConnected}
            />
          )}

          {/* ==================== USER DIRECTORY TAB ==================== */}
          {activeTab === 'users' && can('userDirectory', 'view') && (
            <UserManagementPage
              usersList={usersList}
              setUsersList={setUsersList}
              isApiConnected={isApiConnected}
              rolePermissions={rolePermissions}
              setRolePermissions={setRolePermissions}
              permModel={permModel}
              onBulkImportClick={() => setShowBulkImportEmployees(true)}
              addToast={addToast}
              onUsersDeleted={handleUsersDeleted}
              currentRole={currentRole}
              departments={departments}
            />
          )}

          {/* ==================== SUPPORT TICKETS TAB ==================== */}
          {activeTab === 'tickets' && (
            <TicketsPage
              isApiConnected={isApiConnected}
              currentRole={currentRole}
              currentUser={currentUser}
              usersList={usersList}
              addToast={addToast}
              canManageTickets={can('tickets', 'manage')}
            />
          )}

          {/* ==================== SLA MANAGEMENT TAB ==================== */}
          {activeTab === 'sla' && (
            <SlaManagementPage
              addToast={addToast}
              canEdit={can('sla', 'create') || can('sla', 'edit') || can('sla', 'manage')}
            />
          )}

          {/* ==================== KNOWLEDGE BASE TAB ==================== */}
          {activeTab === 'knowledge_base' && (
            <KnowledgeBasePage
              canAuthor={can('knowledge', 'create')}
              addToast={addToast}
            />
          )}
            </>
            )}
            </Suspense>
            </AsyncBoundary>
            </motion.div>
          </AnimatePresence>

        </div>
      </main>

      {/* ==================== DIALOG MODALS VIEWPORTS ==================== */}
      
      {/* 1. Register Asset Modal */}
      {addAssetModal && (
        <Modal
          isOpen
          onClose={() => setAddAssetModal(false)}
          title="Register Organization Asset"
          as="form"
          onSubmit={handleAddAsset}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setAddAssetModal(false)}>Cancel</button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={addingAsset} loadingText="Filing…">File Asset Record</SpinnerButton>

            </>
          }
        >

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Asset Classification</label>
                    <CustomSelect
                      name="category"
                      options={[
                        { value: "IT", label: "IT Hardware" },
                        { value: "Office", label: "Office Infrastructure" }
                      ]}
                      value={addAssetCategory}
                      onChange={(e) => { setAddAssetCategory(e.target.value); setAddAssetType(''); }}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Equipment Name *</label>
                    <input type="text" name="name" placeholder="e.g. ThinkPad L14" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Asset Tag Subtype *</label>
                    <CustomSelect
                      name="type"
                      placeholder="Select item type…"
                      options={(assetSubtypes[addAssetCategory] || []).map(s => ({ value: s, label: s }))}
                      value={addAssetType}
                      onChange={(e) => setAddAssetType(e.target.value)}
                      required
                      searchable
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Manufacturer Serial Number</label>
                    <input type="text" name="serialNumber" placeholder="e.g. S/N-982180" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Initial Quantity *</label>
                    <input type="number" name="quantity" defaultValue={1} min={1} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Unit of Measure *</label>
                    <input type="text" name="unit" defaultValue="pcs" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Brand / Make</label>
                    <input type="text" name="brand" placeholder="e.g. Lenovo" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Model Series</label>
                    <input type="text" name="model" placeholder="e.g. L14 Gen 4" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Purchase Expense Cost (₹)</label>
                    <input type="number" name="cost" placeholder="1000" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Purchase Date</label>
                    <input type="date" name="purchaseDate" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Warranty Expiry Date</label>
                    <input type="date" name="warrantyExpiry" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Procured Invoice Ref</label>
                    <CustomSelect
                      name="invoiceId"
                      options={[
                        { value: "", label: "-- No associated invoice --" },
                        ...invoices.map(i => ({ value: i.id, label: `${i.id} - ${i.vendor}` }))
                      ]}
                      value={addAssetInvoiceId}
                      onChange={(e) => setAddAssetInvoiceId(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Supplier / Vendor</label>
                    <input type="text" name="supplier" placeholder="e.g. Lenovo Store" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Initial Location Branch</label>
                    <input type="text" name="location" placeholder="e.g. London HQ" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Associated Office Dept</label>
                    <input type="text" name="department" placeholder="e.g. Engineering" className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Associate Department</label>
                    <input type="text" name="associateDepartment" placeholder="e.g. Facilities (optional)" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Useful Lifespan (Depreciation Years)</label>
                    <input type="number" name="depreciationLifeYears" min={0} placeholder="Optional" className="form-input" />
                  </div>
                  <div className="form-group full-width">
                    <label className="form-label">Administrative Notes</label>
                    <textarea name="notes" placeholder="Write any asset configurations, tags, or repairs logs here..." className="form-input"></textarea>
                  </div>
                </div>
        </Modal>
      )}

      {/* 2. Edit Asset Modal */}
      {editAssetModal && (
        <Modal
          isOpen
          onClose={() => setEditAssetModal(null)}
          title={<>Edit Asset {editAssetModal.id} Specs</>}
          as="form"
          onSubmit={handleEditAsset}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setEditAssetModal(null)} disabled={editingAsset}>Cancel</button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={editingAsset} loadingText="Saving…">Save Changes</SpinnerButton>

            </>
          }
        >

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Equipment Model Name</label>
                    <input type="text" name="name" defaultValue={editAssetModal.name} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Asset Tag Subtype</label>
                    <CustomSelect
                      name="type"
                      placeholder="Select item type…"
                      options={(() => {
                        const base = assetSubtypes[editAssetModal.category] || [];
                        // Keep any legacy free-text value selectable so an edit never
                        // silently drops it.
                        const merged = editAssetType && !base.includes(editAssetType) ? [editAssetType, ...base] : base;
                        return merged.map(s => ({ value: s, label: s }));
                      })()}
                      value={editAssetType}
                      onChange={(e) => setEditAssetType(e.target.value)}
                      required
                      searchable
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Manufacturer Serial Number</label>
                    <input type="text" name="serialNumber" defaultValue={editAssetModal.serialNumber} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Total Quantity *</label>
                    <input type="number" name="totalQuantity" defaultValue={editAssetModal.totalQuantity || 1} min={1} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Unit of Measure *</label>
                    <input type="text" name="unit" defaultValue={editAssetModal.unit || 'pcs'} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Brand / Make</label>
                    <input type="text" name="brand" defaultValue={editAssetModal.brand || ''} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Model Series</label>
                    <input type="text" name="model" defaultValue={editAssetModal.model || ''} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Purchase Expense Cost (₹)</label>
                    <input type="number" name="cost" defaultValue={editAssetModal.cost} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Purchase Date</label>
                    <input type="date" name="purchaseDate" defaultValue={editAssetModal.purchaseDate} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Warranty Expiry Date</label>
                    <input type="date" name="warrantyExpiry" defaultValue={editAssetModal.warrantyExpiry} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Procured Invoice Ref</label>
                    <CustomSelect
                      name="invoiceId"
                      options={[
                        { value: "", label: "-- No associated invoice --" },
                        ...invoices.map(i => ({ value: i.id, label: `${i.id} - ${i.vendor}` }))
                      ]}
                      value={editAssetInvoiceId}
                      onChange={(e) => setEditAssetInvoiceId(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Supplier / Vendor</label>
                    <input type="text" name="supplier" defaultValue={editAssetModal.supplier || ''} className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Location Branch</label>
                    <input type="text" name="location" defaultValue={editAssetModal.location} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Associated Office Dept</label>
                    <input type="text" name="department" defaultValue={editAssetModal.department} className="form-input" required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Associate Department</label>
                    <input type="text" name="associateDepartment" defaultValue={editAssetModal.associateDepartment || ''} placeholder="Optional" className="form-input" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Useful Lifespan (Depreciation Years)</label>
                    <input type="number" name="depreciationLifeYears" min={0} defaultValue={editAssetModal.depreciationLifeYears ?? ''} placeholder="Optional" className="form-input" />
                  </div>
                  <div className="form-group full-width">
                    <label className="form-label">Administrative Notes</label>
                    <textarea name="notes" defaultValue={editAssetModal.notes} className="form-input"></textarea>
                  </div>
                </div>
        </Modal>
      )}

      {/* 3. Allocate Asset Modal */}
      {allocateModal && (
        <Modal
          isOpen
          onClose={() => setAllocateModal(null)}
          title={<>Allocate Asset {allocateModal.id}</>}
          as="form"
          onSubmit={handleAllocate}
          maxWidth="450px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setAllocateModal(null)} disabled={isAllocating}>Cancel</button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={allocateModal.availableQuantity === 0 || isAllocating}
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {isAllocating ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    Authorizing…
                  </>
                ) : 'Authorize Allocation'}
              </button>

            </>
          }
        >

                <div style={{ background: 'var(--bg-sidebar)', padding: '12px 16px', borderRadius: 'var(--radius-md)', marginBottom: '16px', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Available Stock:</span>
                    <span style={{ fontWeight: '700', color: (allocateModal.availableQuantity || 0) === 0 ? 'var(--status-disposed)' : 'var(--status-available)' }}>
                      {allocateModal.availableQuantity !== undefined ? allocateModal.availableQuantity : 1} {allocateModal.unit || 'pcs'}
                    </span>
                  </div>
                  {allocateModal.availableQuantity === 0 && (
                    <div style={{ color: 'var(--status-disposed)', fontSize: '11px', marginTop: '6px', fontWeight: '600' }}>
                      ⚠️ Out of stock! This asset cannot be allocated.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">Select Employee Custodian</label>
                  <CustomSelect
                    name="employee"
                    options={employeeOptions}
                    value={allocateEmployee}
                    onChange={(e) => {
                      const name = e.target.value;
                      setAllocateEmployee(name);
                      // Department follows the chosen employee. If they have no
                      // department on record, clear it rather than leaving a stale
                      // value, so the placeholder shows instead of wrong data.
                      const match = findEmployeeByName(name);
                      setAllocateDepartment(match?.department || '');
                    }}
                    required
                    searchable
                    searchPlaceholder="Search by name, department or ID..."
                    placeholder="Select an active employee..."
                    disabled={allocateModal.availableQuantity === 0}
                  />
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Allocation Department</label>
                  <input
                    type="text"
                    name="department"
                    value={allocateDepartment}
                    onChange={(e) => setAllocateDepartment(e.target.value)}
                    placeholder={allocateEmployee ? 'No department on record — enter one' : 'Select an employee to auto-fill'}
                    className="form-input"
                    required
                    disabled={allocateModal.availableQuantity === 0}
                  />
                  {allocateEmployee && findEmployeeByName(allocateEmployee)?.department && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Auto-filled from {allocateEmployee}. You can still override it.
                    </span>
                  )}
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Assign Quantity *</label>
                  <input type="number" name="quantity" defaultValue={1} min={1} max={allocateModal.availableQuantity || 1} className="form-input" required disabled={allocateModal.availableQuantity === 0} />
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Assignment Date</label>
                  <input type="date" name="date" defaultValue={new Date().toISOString().split('T')[0]} className="form-input" required disabled={allocateModal.availableQuantity === 0} />
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Allocation Notes / SLA terms</label>
                  <textarea name="notes" placeholder="e.g. Device assigned for remote engineering duties." className="form-input" disabled={allocateModal.availableQuantity === 0}></textarea>
                </div>
        </Modal>
      )}

      {/* 4. Transfer Asset Modal */}
      {transferModal && (
        <Modal
          isOpen
          onClose={() => setTransferModal(null)}
          title={<>Transfer Asset {transferModal.id}</>}
          as="form"
          onSubmit={handleTransfer}
          maxWidth="480px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setTransferModal(null)} disabled={isTransferring}>Cancel</button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isTransferring}
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {isTransferring ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    Authorizing Transfer…
                  </>
                ) : 'Authorize Transfer'}
              </button>

            </>
          }
        >

                <div style={{ padding: '10px', backgroundColor: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }}>
                  Current Custodian: <strong>{transferModal.assignedEmployee || "Inventory"}</strong> ({transferModal.department})
                </div>

                <div className="form-group">
                  <label className="form-label">Transfer Target Destination</label>
                  <CustomSelect
                    name="targetType"
                    options={[
                      { value: "employee", label: "Another Employee Custodian" },
                      { value: "department", label: "Back to Department Inventory" }
                    ]}
                    value={transferTargetType}
                    onChange={(e) => {
                      const next = e.target.value;
                      setTransferTargetType(next);
                      // Changing the destination re-derives every dependent field
                      // immediately so the form never carries stale values.
                      if (next === 'department') {
                        // Returning to inventory: land the asset back in its
                        // home department by default (still editable below).
                        setTransferEmployee('');
                        setTransferDepartment(transferModal.department || '');
                      } else {
                        // Moving to a custodian: department follows the chosen
                        // employee, or clears until one is picked.
                        const match = findEmployeeByName(transferEmployee);
                        setTransferDepartment(match?.department || '');
                      }
                    }}
                    required
                  />
                </div>

                {transferTargetType !== 'department' && (
                  <div className="form-group" style={{ marginTop: '12px' }}>
                    <label className="form-label">New Employee Custodian</label>
                    <CustomSelect
                      name="employee"
                      options={employeeOptions}
                      value={transferEmployee}
                      onChange={(e) => {
                        const name = e.target.value;
                        setTransferEmployee(name);
                        // Department follows the custodian, so the relocation lands in
                        // the right queue without the operator retyping it.
                        const match = findEmployeeByName(name);
                        if (match?.department) setTransferDepartment(match.department);
                      }}
                      required
                      searchable
                      searchPlaceholder="Search by name, department or ID..."
                      placeholder="Select an active employee..."
                    />
                  </div>
                )}

                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Target Department</label>
                  <input
                    type="text"
                    name="department"
                    value={transferDepartment}
                    onChange={(e) => setTransferDepartment(e.target.value)}
                    className="form-input"
                    required
                  />
                  {transferTargetType === 'employee' && findEmployeeByName(transferEmployee)?.department && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Auto-filled from {transferEmployee}. You can still override it.
                    </span>
                  )}
                  {transferTargetType === 'department' && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      Auto-filled from the asset's home department. You can still override it.
                    </span>
                  )}
                </div>

                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Target Branch / Location</label>
                  <input type="text" name="location" defaultValue={transferModal.location} className="form-input" required />
                </div>

                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Transfer / Movement Date</label>
                  <input type="date" name="date" defaultValue={new Date().toISOString().split('T')[0]} className="form-input" required />
                </div>

                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Transfer Rationale (optional)</label>
                  <textarea name="notes" placeholder="Reason for custodian shift or branch relocation (optional)..." className="form-input"></textarea>
                </div>
        </Modal>
      )}

      {/* 5. Return Asset Modal */}
      {returnModal && (
        <Modal
          isOpen
          onClose={() => setReturnModal(null)}
          title={<>Return Asset {returnModal.id}</>}
          as="form"
          onSubmit={handleReturn}
          maxWidth="450px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setReturnModal(null)} disabled={returningAsset}>Cancel</button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={returningAsset} loadingText="Returning…">Record Return</SpinnerButton>

            </>
          }
        >

                <div style={{ padding: '10px', backgroundColor: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }}>
                  Returning from Custodian: <strong>{returnModal.assignedEmployee}</strong> ({returnModal.department})
                </div>
                <div className="form-group">
                  <label className="form-label">Return Location / Warehouse</label>
                  <input type="text" name="location" defaultValue={returnModal.location} className="form-input" required />
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Return Log Date</label>
                  <input type="date" name="date" defaultValue={new Date().toISOString().split('T')[0]} className="form-input" required />
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Asset Condition Notes on Return</label>
                  <textarea name="notes" placeholder="Verify physical status (e.g. Scratch-free, Charger returned)..." className="form-input" required></textarea>
                </div>
        </Modal>
      )}

      {/* 5.1 Bulk Import Employees Modal */}
      <BulkImportModal
        isOpen={showBulkImportEmployees}
        onClose={() => setShowBulkImportEmployees(false)}
        type="employees"
        isApiConnected={isApiConnected}
        usersList={usersList}
        onImportComplete={(updatedUsers) => {
          if (updatedUsers) setUsersList(updatedUsers);
          // Refetch users from API if active
          if (isApiConnected) {
            api.getUsers().then(u => setUsersList(u));
          }
        }}
      />

      {/* 5.2 Bulk Import Assets Modal */}
      <BulkImportModal
        isOpen={showBulkImportAssets}
        onClose={() => setShowBulkImportAssets(false)}
        type="assets"
        isApiConnected={isApiConnected}
        assetsList={assets}
        assetSubtypes={assetSubtypes}
        onImportComplete={(updatedAssets) => {
          if (updatedAssets) setAssets(updatedAssets);
          // Refetch assets from API if active
          if (isApiConnected) {
            api.getAssets().then(a => setAssets(a));
          }
        }}
      />

      {/* 5.3 Bulk Import Invoices Modal */}
      <BulkImportModal
        isOpen={showBulkImportInvoices}
        onClose={() => setShowBulkImportInvoices(false)}
        type="invoices"
        isApiConnected={isApiConnected}
        assetsList={invoices}
        onImportComplete={(updatedInvoices) => {
          if (updatedInvoices) setInvoices(updatedInvoices);
          if (isApiConnected) {
            api.getInvoices().then(invs => setInvoices(invs));
          }
        }}
      />

      {/* 5.2.1 User Profile Modal */}
      {showProfileModal && (
        <Modal
          isOpen
          onClose={() => setShowProfileModal(false)}
          title="My Employee Profile"
          maxWidth="440px"
          footer={
            <button className="btn btn-secondary" onClick={() => setShowProfileModal(false)}>Close Profile</button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--primary)',
                  color: 'var(--ink-contrast)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '24px',
                  fontWeight: '700'
                }}>
                  {currentUser ? currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase() : (currentRole === 'Employee' ? 'AJ' : currentRole.substring(0, 2).toUpperCase())}
                </div>
                <div>
                  <h4 style={{ fontSize: '18px', fontWeight: '700', margin: 0 }}>{currentUser ? currentUser.name : (currentRole === 'Employee' ? 'Alice Johnson' : 'Admin Operations')}</h4>
                  <span className="badge" style={{ backgroundColor: 'var(--primary-glow)', color: 'var(--primary)', marginTop: '4px', display: 'inline-block' }}>{currentRole}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '14px', fontSize: '13px' }}>
                <div><strong>Employee ID:</strong> {currentUser?.employeeId || 'EMP-' + (currentUser?.id || '001')}</div>
                <div><strong>Username:</strong> {currentUser?.username || 'admin'}</div>
                <div><strong>Email:</strong> {currentUser?.email || 'admin@company.com'}</div>
                <div><strong>Phone Number:</strong> {currentUser?.phoneNumber || '—'}</div>
                <div><strong>Department:</strong> {currentUser?.department || 'Operations'}</div>
                <div><strong>Designation:</strong> {currentUser?.designation || 'Staff Administrator'}</div>
                <div><strong>Account Status:</strong> <span style={{ color: 'var(--status-available)', fontWeight: '600' }}>{currentUser?.status || 'Active'}</span></div>
              </div>
          </div>
        </Modal>
      )}

      {/* 5.3 Edit Assignment Modal */}
      {editAssignmentModal && (
        <Modal
          isOpen
          onClose={() => setEditAssignmentModal(null)}
          title="Edit Custodian Assignment"
          as="form"
          onSubmit={handleEditAssignmentSubmit}
          maxWidth="450px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setEditAssignmentModal(null)} disabled={savingAssignment}>Cancel</button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={savingAssignment} loadingText="Saving…">Save Changes</SpinnerButton>

            </>
          }
        >

                <div className="form-group">
                  <label className="form-label">Employee Custodian Name</label>
                  <input type="text" name="employeeName" defaultValue={editAssignmentModal.employeeName} className="form-input" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Department</label>
                  <input type="text" name="department" defaultValue={editAssignmentModal.department} className="form-input" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Assigned Quantity (Max Available: {editAssignmentModal.quantity + (assets.find(a => a.id === editAssignmentModal.assetId)?.availableQuantity || 0)})</label>
                  <input 
                    type="number" 
                    name="quantity" 
                    defaultValue={editAssignmentModal.quantity} 
                    min={1} 
                    max={editAssignmentModal.quantity + (assets.find(a => a.id === editAssignmentModal.assetId)?.availableQuantity || 0)} 
                    className="form-input" 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Administrative Notes</label>
                  <textarea name="notes" defaultValue={editAssignmentModal.notes || ''} className="form-input"></textarea>
                </div>
        </Modal>
      )}

      {/* 5.4 Return Assignment Modal */}
      {returnAssignmentModal && (
        <Modal
          isOpen
          onClose={() => setReturnAssignmentModal(null)}
          title="Return Assignment Stock"
          as="form"
          onSubmit={handleReturnAssignmentSubmit}
          maxWidth="450px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setReturnAssignmentModal(null)} disabled={returningAssignment}>Cancel</button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={returningAssignment} loadingText="Returning…">Record Return</SpinnerButton>
            </>
          }
        >

                <div style={{ padding: '12px 16px', background: 'var(--bg-sidebar)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                  <div>Asset: <strong>{returnAssignmentModal.assetId}</strong></div>
                  <div>Assigned Custodian: <strong>{returnAssignmentModal.employeeName}</strong></div>
                  <div>Current Hold Quantity: <strong>{returnAssignmentModal.quantity}</strong></div>
                </div>
                <div className="form-group">
                  <label className="form-label">Return Quantity (Max: {returnAssignmentModal.quantity})</label>
                  <input type="number" name="quantity" defaultValue={returnAssignmentModal.quantity} min={1} max={returnAssignmentModal.quantity} className="form-input" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Return Location Branch</label>
                  <input type="text" name="location" defaultValue="Inventory" className="form-input" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Return Notes / Condition</label>
                  <textarea name="notes" placeholder="Verify physical status (e.g. Scratched screen, fully functional)" className="form-input"></textarea>
                </div>
        </Modal>
      )}

      {/* 6. QR Sticker Modal */}
      {qrStickerModal && (
        <Modal
          isOpen
          onClose={() => setQrStickerModal(null)}
          title={<>Security tag {qrStickerModal.id}</>}
          maxWidth="380px"
          bodyStyle={{ alignItems: 'center', backgroundColor: 'var(--bg-app)' }}
          footer={
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => window.print()}>
              Print Sticker Label
            </button>
          }
        >
          <QRCodeSticker asset={qrStickerModal} />
          <p style={{ fontSize: '11px', textAlign: 'center', color: 'var(--text-secondary)', marginTop: '8px' }}>
            Printable label contains encrypted validation payload and dual barcode patterns.
          </p>
        </Modal>
      )}

      {/* 7. Asset Details / Custody Timeline Modal */}
      {assetDetailModal && (
        <Modal
          isOpen
          onClose={() => setAssetDetailModal(null)}
          title={<>Lifecycle & Timeline: {assetDetailModal.id}</>}
          maxWidth="600px"
          footer={
            <>
              <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => setAssetDetailModal(null)}>
                Dismiss Details
              </button>

            </>
          }
        >

              {/* Core Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                <div>
                  <h4 style={{ fontSize: '15px', color: 'var(--text-primary)' }}>{assetDetailModal.name}</h4>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Serial: {assetDetailModal.serialNumber}</span>
                  <div style={{ marginTop: '8px' }}>
                    <span className={`badge badge-${assetDetailModal.status.toLowerCase().replace(' ', '-')}`}>
                      {assetDetailModal.status}
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div><strong>Category:</strong> {assetDetailModal.category} ({assetDetailModal.type})</div>
                  <div><strong>Value Cost:</strong> {formatINR(assetDetailModal.cost)}</div>
                  <div><strong>Purchase:</strong> {assetDetailModal.purchaseDate}</div>
                  <div><strong>Warranty Exp:</strong> {assetDetailModal.warrantyExpiry}</div>
                  {assetDetailModal.amcId && <div><strong>AMC Linked:</strong> {assetDetailModal.amcId}</div>}
                  {assetDetailModal.invoiceId && (() => {
                    const linkedInv = invoices.find(inv => inv.id === assetDetailModal.invoiceId);
                    return (
                      <div>
                        <strong>Invoice Map:</strong>{' '}
                        <button 
                          onClick={() => {
                            if (linkedInv) {
                              setInvoiceDetailModal(linkedInv);
                              setAssetDetailModal(null);
                            } else {
                              setAssetDetailModal(null);
                              setActiveTab('finance');
                              setFinanceSubTab('all');
                            }
                          }}
                          style={{ background: 'none', border: 'none', padding: 0, margin: 0, color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit', fontWeight: 'bold' }}
                        >
                          {assetDetailModal.invoiceId} {linkedInv ? `(${linkedInv.vendor})` : ''}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Depreciation calculation widget */}
              <div style={{ backgroundColor: 'var(--bg-app)', border: '1px solid var(--border-color)', padding: '12px', borderRadius: '6px' }}>
                <h4 style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px' }}>Depreciation & Asset Value Lifespan</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span>Calculated useful life:</span>
                  <span><strong>{assetDetailModal.depreciationLifeYears ? `${assetDetailModal.depreciationLifeYears} Years` : 'Not set'}</strong></span>
                </div>
                {/* Straight line depreciation mockup — only meaningful when a useful
                    life has been recorded, which is now optional. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginTop: '4px' }}>
                  <span>Current Residual Value:</span>
                  <span style={{ color: 'var(--status-available)', fontWeight: '700' }}>
                    {assetDetailModal.depreciationLifeYears
                      ? formatINR(Math.max(0, assetDetailModal.cost - (assetDetailModal.cost / assetDetailModal.depreciationLifeYears) * (new Date().getFullYear() - new Date(assetDetailModal.purchaseDate).getFullYear())))
                      : '—'}
                  </span>
                </div>
              </div>

              {/* Timeline nodes mapping */}
              <div>
                <h4 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--text-primary)' }}>Custody & Movement History Log</h4>
                <div className="timeline-container">
                  {movements.filter(m => m.assetId === assetDetailModal.id).map(mvt => (
                    <div key={mvt.id} className="timeline-node">
                      <div className={`timeline-dot ${mvt.type === 'Procurement' ? 'success' : mvt.type === 'Allocation' ? 'info' : mvt.type === 'Disposal' ? 'danger' : 'warning'}`}></div>
                      <div className="timeline-content">
                        <div className="timeline-date-row">
                          <span className="timeline-date">{mvt.date}</span>
                          <span className="timeline-actor">By: {mvt.actor}</span>
                        </div>
                        <span className="timeline-title">{mvt.type} Event</span>
                        <span className="timeline-desc">From: <strong>{mvt.from}</strong> → To: <strong>{mvt.to}</strong></span>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', borderTop: '1px dashed var(--border-color)', paddingTop: '4px' }}>
                          Notes: {mvt.notes}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
        </Modal>
      )}

      {/* 8. Invoice Details Modal */}
      {invoiceDetailModal && (
        <Modal
          isOpen
          onClose={() => setInvoiceDetailModal(null)}
          title={<>Purchase Invoice Details: {invoiceDetailModal.id}</>}
          maxWidth="600px"
          footer={
            <>
              <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => setInvoiceDetailModal(null)}>
                Dismiss Details
              </button>

            </>
          }
        >

              {/* Invoice Specs */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div><strong>Vendor:</strong> {invoiceDetailModal.vendor}</div>
                  <div><strong>PO Reference:</strong> {invoiceDetailModal.poReference || 'N/A'}</div>
                  <div><strong>Issue Date:</strong> {invoiceDetailModal.date}</div>
                  <div>
                    <strong>Status:</strong>{' '}
                    <span className="badge" style={{
                      backgroundColor: invoiceDetailModal.paymentStatus === 'Paid' ? 'var(--status-available-bg)' : invoiceDetailModal.paymentStatus === 'Pending' ? 'var(--status-maintenance-bg)' : invoiceDetailModal.paymentStatus === 'Overdue' ? 'var(--status-disposed-bg)' : 'var(--status-assigned-bg)',
                      color: invoiceDetailModal.paymentStatus === 'Paid' ? 'var(--status-available)' : invoiceDetailModal.paymentStatus === 'Pending' ? 'var(--status-maintenance)' : invoiceDetailModal.paymentStatus === 'Overdue' ? 'var(--status-disposed)' : 'var(--status-assigned)'
                    }}>
                      {invoiceDetailModal.paymentStatus}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div><strong>Base Amount:</strong> {formatINR(invoiceDetailModal.amount)}</div>
                  <div><strong>GST Rate:</strong> {invoiceDetailModal.gst}%</div>
                  <div><strong>Total Amount:</strong> {formatINR(Number(invoiceDetailModal.amount || 0) + (Number(invoiceDetailModal.amount || 0) * (Number(invoiceDetailModal.gst || 0) / 100)))}</div>
                  <div>
                    <strong>Attached Scan:</strong>{' '}
                    {invoiceDetailModal.fileName && invoiceDetailModal.fileName !== 'None' && invoiceDetailModal.fileName !== 'invoice.pdf' ? (
                      <a 
                        href={`/api/files/${invoiceDetailModal.fileName}`} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="btn btn-secondary btn-sm" 
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px'}}
                      >
                        📄 View PDF Scan
                      </a>
                    ) : ( 
                      <span style={{ color: 'var(--status-disposed)', fontWeight: '600', fontSize: '11.5px' }}>
                        ⚠️ Pending Scan Upload
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Linked Assets Section */}
              <div style={{ marginTop: '16px' }}>
                <h4 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Linked Assets Directory</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
                    Click an asset to inspect details
                  </span>
                </h4>
                
                {assets.filter(a => a.invoiceId === invoiceDetailModal.id).length === 0 ? (
                  <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', border: '1px dashed var(--border-color)', borderRadius: '6px', fontSize: '12px' }}>
                    No assets linked to this purchase invoice yet. Go to "Asset Mapping" to link inventory items.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px' }}>
                    {assets.filter(a => a.invoiceId === invoiceDetailModal.id).map(asset => (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => {
                          setAssetDetailModal(asset);
                          setInvoiceDetailModal(null);
                        }}
                        className="btn btn-secondary"
                        style={{ 
                          padding: '8px 10px', 
                          borderRadius: '6px', 
                          display: 'flex', 
                          flexDirection: 'column', 
                          alignItems: 'flex-start',
                          gap: '2px',
                          textAlign: 'left',
                          width: '100%',
                          border: '1px solid var(--border-color)',
                          cursor: 'pointer'
                        }}
                      >
                        <span style={{ fontWeight: '700', color: 'var(--primary)', fontSize: '12px' }}>{asset.id}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>{asset.name}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Val: {formatINR(asset.cost)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Upload PDF later option if missing */}
              {(!invoiceDetailModal.fileName || invoiceDetailModal.fileName === 'None' || invoiceDetailModal.fileName === 'invoice.pdf') && ( 
                <div style={{ 
                  marginTop: '16px', 
                  border: '2px dashed var(--border-color)', 
                  borderRadius: 'var(--radius-lg)', 
                  padding: '16px', 
                  background: 'var(--bg-sidebar)',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span style={{ fontSize: '12px', fontWeight: '600' }}>Add Invoice PDF Scan Attachment</span>
                  <input 
                    type="file" 
                    accept=".pdf" 
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        await handleUploadPdfForInvoice(invoiceDetailModal.id, file);
                        setInvoiceDetailModal(prev => ({ ...prev, fileName: file.name }));
                      } 
                    }} 
                    style={{ fontSize: '12px', width: '100%', maxWidth: '240px' }} 
                  />
                </div>
              )}
        </Modal>
      )}

    </div>
    </AppDataProvider>
  );
}

export default App
