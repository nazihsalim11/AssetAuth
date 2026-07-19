/**
 * Notification templates.
 *
 * One entry per event type, rendering the same event for all three channels so the
 * wording cannot drift between them. Each template returns:
 *
 *   type    - severity, drives the in-app dot colour ('info' | 'warning' | 'error')
 *   subject - email subject line
 *   inApp   - short text for the bell popover
 *   email   - full body
 *   sms     - terse body; SMS is billed per 160 characters, so keep it tight
 *
 * `ctx` is the event payload assembled by the caller.
 */

const fmtDate = (value) => {
  if (!value) return 'an unknown date';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().split('T')[0];
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Invoice amounts are rupees throughout the app.
const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? `Rs ${n.toLocaleString('en-IN')}` : String(value ?? 'an unknown amount');
};

// A request's field-level diff, rendered for humans. `changes` is the shape produced by
// backend/src/requests/diff.js: [{ label, before, after }].
const val = (v) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const changeList = (changes = []) =>
  changes.length ? changes.map((c) => c.label).join(', ') : 'none';
const changeBlock = (changes = []) =>
  changes.length
    ? changes.map((c) => `  • ${c.label}: ${val(c.before)} → ${val(c.after)}`).join('\n')
    : '  (no field changes)';

const templates = {
  'ticket.created': (c) => ({
    type: c.priority === 'Critical' ? 'error' : c.priority === 'Medium' ? 'warning' : 'info',
    subject: `[${c.ticketId}] New ${c.priority} ticket: ${c.subject}`,
    inApp: `New ${c.priority} ticket ${c.ticketId} in ${c.department}: "${c.subject}"`,
    email:
      `A new ticket has been raised.\n\n` +
      `Ticket:      ${c.ticketId}\n` +
      `Subject:     ${c.subject}\n` +
      `Department:  ${c.department}\n` +
      `Priority:    ${c.priority}\n` +
      `Raised by:   ${c.createdByName}\n` +
      `SLA due:     ${fmtDate(c.slaDeadline)}\n\n` +
      `${c.description || ''}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: new ${c.priority} ticket ${c.ticketId} (${c.department}) - ${c.subject}`
  }),

  'ticket.assigned': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Assigned to ${c.assignedToName}`,
    inApp: `Ticket ${c.ticketId} assigned to ${c.assignedToName}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been assigned to ${c.assignedToName}.\n\n` +
      `Priority: ${c.priority}\nSLA due:  ${fmtDate(c.slaDeadline)}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} assigned to ${c.assignedToName}`
  }),

  'ticket.status_changed': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Status changed to ${c.status}`,
    inApp: `Ticket ${c.ticketId} moved from ${c.previousStatus} to ${c.status}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") changed status.\n\n` +
      `Previous: ${c.previousStatus}\nCurrent:  ${c.status}\nUpdated by: ${c.actorName}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} is now ${c.status}`
  }),

  'ticket.priority_changed': (c) => ({
    type: c.priority === 'Critical' ? 'error' : 'info',
    subject: `[${c.ticketId}] Priority changed to ${c.priority}`,
    inApp: `Ticket ${c.ticketId} priority changed from ${c.previousPriority} to ${c.priority}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") changed priority.\n\n` +
      `Previous: ${c.previousPriority}\nCurrent:  ${c.priority}\nUpdated by: ${c.actorName}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} priority is now ${c.priority}`
  }),

  'ticket.reopened': (c) => ({
    type: 'warning',
    subject: `[${c.ticketId}] Reopened`,
    inApp: `Ticket ${c.ticketId} has been reopened`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") was reopened by ${c.actorName} after being ${c.previousStatus}.\n\n` +
      `Recommended action: review the original resolution and continue work.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} reopened`
  }),

  'ticket.resolved': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Resolved`,
    inApp: `Ticket ${c.ticketId} has been resolved`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been marked resolved by ${c.actorName}.\n\n` +
      `If the issue persists, reopen the ticket from the service desk.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} resolved`
  }),

  'ticket.closed': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Closed`,
    inApp: `Ticket ${c.ticketId} has been closed`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been closed by ${c.actorName}.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} closed`
  }),

  'ticket.escalated': (c) => ({
    type: 'error',
    subject: `[${c.ticketId}] ESCALATED — SLA breached`,
    inApp: `Ticket ${c.ticketId} escalated: SLA breached ${plural(c.hoursOverdue, 'hour')} ago`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has breached its SLA and been escalated.\n\n` +
      `Department: ${c.department}\n` +
      `Priority:   ${c.priority}\n` +
      `Assigned:   ${c.assignedToName || 'Unassigned'}\n` +
      `SLA due:    ${fmtDate(c.slaDeadline)}\n` +
      `Overdue by: ${plural(c.hoursOverdue, 'hour')}\n\n` +
      `Recommended action: reassign or prioritise this ticket immediately.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} ESCALATED, SLA breached by ${plural(c.hoursOverdue, 'hour')}`
  }),

  'ticket.escalation_level': (c) => ({
    type: 'error',
    subject: `[${c.ticketId}] Escalated to level ${c.level}`,
    inApp: `Ticket ${c.ticketId} escalated to level ${c.level} — ${c.targetLabel}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has reached SLA escalation level ${c.level}.\n\n` +
      `Department: ${c.department}\n` +
      `Priority:   ${c.priority}\n` +
      `Assigned:   ${c.assignedToName || 'Unassigned'}\n` +
      `Resolution due: ${fmtDate(c.resolutionDue)}\n` +
      `Escalated to: ${c.targetLabel}\n\n` +
      `Recommended action: intervene to keep this ticket within its SLA.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} escalated to level ${c.level} (${c.targetLabel})`
  }),

  'ticket.reassigned': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Reassigned to ${c.assignedToName}`,
    inApp: `Ticket ${c.ticketId} reassigned from ${c.previousAssigneeName || 'previous agent'} to ${c.assignedToName}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been reassigned.\n\n` +
      `From: ${c.previousAssigneeName || 'previous agent'}\n` +
      `To:   ${c.assignedToName}\n` +
      `By:   ${c.actorName}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} reassigned to ${c.assignedToName}`
  }),

  'ticket.sla_approaching': (c) => ({
    type: 'warning',
    subject: `[${c.ticketId}] SLA due in ${plural(c.hoursRemaining, 'hour')}`,
    inApp: `Ticket ${c.ticketId} SLA due in ${plural(c.hoursRemaining, 'hour')}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") is approaching its SLA deadline.\n\n` +
      `Assigned:  ${c.assignedToName || 'Unassigned'}\n` +
      `SLA due:   ${fmtDate(c.slaDeadline)}\n` +
      `Remaining: ${plural(c.hoursRemaining, 'hour')}\n\n` +
      `Recommended action: resolve or reassign before the deadline.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} SLA due in ${plural(c.hoursRemaining, 'hour')}`
  }),

  'ticket.sla_breached': (c) => ({
    type: 'error',
    subject: `[${c.ticketId}] SLA BREACHED`,
    inApp: `Ticket ${c.ticketId} has breached its SLA`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has passed its SLA deadline of ${fmtDate(c.slaDeadline)}.\n\n` +
      `Assigned: ${c.assignedToName || 'Unassigned'}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} SLA BREACHED`
  }),

  'asset.warranty_expiring': (c) => ({
    type: 'warning',
    subject: `Warranty expiring in ${plural(c.daysRemaining, 'day')}: ${c.assetId}`,
    inApp: `Warranty for ${c.assetId} (${c.assetName}) expires in ${plural(c.daysRemaining, 'day')}`,
    email:
      `An asset warranty is approaching expiry.\n\n` +
      `Asset ID:        ${c.assetId}\n` +
      `Asset name:      ${c.assetName}\n` +
      `Serial number:   ${c.serialNumber || 'N/A'}\n` +
      `Warranty expiry: ${fmtDate(c.expiryDate)}\n` +
      `Remaining:       ${plural(c.daysRemaining, 'day')}\n` +
      `Assigned to:     ${c.assignedEmployee || 'Unassigned (in inventory)'}\n` +
      `Department:      ${c.department || 'N/A'}\n\n` +
      `Recommended action: raise a renewal request with the vendor, or plan replacement ` +
      `before the warranty lapses.\n\n— AssetFlow Monitoring`,
    sms: `AssetFlow: warranty for ${c.assetId} expires in ${plural(c.daysRemaining, 'day')} (${fmtDate(c.expiryDate)})`
  }),

  'amc.expiring': (c) => ({
    type: 'warning',
    subject: `AMC expiring in ${plural(c.daysRemaining, 'day')}: ${c.amcId}`,
    inApp: `AMC ${c.amcId} with ${c.vendor} expires in ${plural(c.daysRemaining, 'day')}`,
    email:
      `An AMC contract is approaching expiry.\n\n` +
      `Contract ID:  ${c.amcId}\n` +
      `Vendor:       ${c.vendor}\n` +
      `Expiry date:  ${fmtDate(c.expiryDate)}\n` +
      `Remaining:    ${plural(c.daysRemaining, 'day')}\n` +
      `Assets under contract: ${c.assetCount}\n` +
      `${c.assetSummary ? `Covered assets: ${c.assetSummary}\n` : ''}` +
      `\nRecommended action: begin renewal negotiation with ${c.vendor}, or arrange ` +
      `alternative cover before the contract lapses.\n\n— AssetFlow Contract Engine`,
    sms: `AssetFlow: AMC ${c.amcId} (${c.vendor}) expires in ${plural(c.daysRemaining, 'day')}`
  }),

  'asset.service_due': (c) => ({
    type: c.daysRemaining <= 0 ? 'error' : 'warning',
    subject: c.daysRemaining <= 0
      ? `Service overdue: AMC ${c.amcId} (${c.vendor})`
      : `Service due in ${plural(c.daysRemaining, 'day')}: AMC ${c.amcId}`,
    inApp: c.daysRemaining <= 0
      ? `Scheduled service for AMC ${c.amcId} (${c.vendor}) is overdue`
      : `Scheduled service for AMC ${c.amcId} (${c.vendor}) is due in ${plural(c.daysRemaining, 'day')}`,
    email:
      `A ${c.schedule || 'scheduled'} maintenance service is ${c.daysRemaining <= 0 ? 'overdue' : 'coming due'}.\n\n` +
      `Contract ID:   ${c.amcId}\n` +
      `Vendor:        ${c.vendor}\n` +
      `Schedule:      ${c.schedule || 'N/A'}\n` +
      `Next service:  ${fmtDate(c.dueDate)}\n` +
      `${c.daysRemaining <= 0 ? `Overdue by:    ${plural(Math.abs(c.daysRemaining), 'day')}\n` : `Due in:        ${plural(c.daysRemaining, 'day')}\n`}` +
      `Assets under contract: ${c.assetCount}\n\n` +
      `Recommended action: schedule the service visit with ${c.vendor} and log it against the contract.\n\n— AssetFlow Contract Engine`,
    sms: `AssetFlow: service for AMC ${c.amcId} (${c.vendor}) ${c.daysRemaining <= 0 ? 'is overdue' : `due in ${plural(c.daysRemaining, 'day')}`}`
  }),

  'asset.return_due': (c) => ({
    type: c.daysRemaining <= 0 ? 'error' : 'warning',
    subject: c.daysRemaining <= 0
      ? `Asset return overdue: ${c.assetId}`
      : `Asset return due in ${plural(c.daysRemaining, 'day')}: ${c.assetId}`,
    inApp: c.daysRemaining <= 0
      ? `${c.employeeName} was due to return ${c.assetId} (${c.assetName}) by ${fmtDate(c.dueDate)}`
      : `${c.employeeName} is due to return ${c.assetId} (${c.assetName}) in ${plural(c.daysRemaining, 'day')}`,
    email:
      `An assigned asset is ${c.daysRemaining <= 0 ? 'overdue for return' : 'due to be returned'}.\n\n` +
      `Asset ID:     ${c.assetId}\n` +
      `Asset name:   ${c.assetName}\n` +
      `Custodian:    ${c.employeeName}\n` +
      `Department:   ${c.department || 'N/A'}\n` +
      `Return by:    ${fmtDate(c.dueDate)}\n` +
      `${c.daysRemaining <= 0 ? `Overdue by:   ${plural(Math.abs(c.daysRemaining), 'day')}\n` : `Due in:       ${plural(c.daysRemaining, 'day')}\n`}` +
      `\nRecommended action: follow up with the custodian to collect the asset back into inventory.\n\n— AssetFlow Monitoring`,
    sms: `AssetFlow: ${c.assetId} return from ${c.employeeName} ${c.daysRemaining <= 0 ? 'is overdue' : `due in ${plural(c.daysRemaining, 'day')}`}`
  }),

  'asset.low_inventory': (c) => ({
    type: c.availableQuantity <= 0 ? 'error' : 'warning',
    subject: c.availableQuantity <= 0
      ? `Out of stock: ${c.assetId} (${c.assetName})`
      : `Low stock: ${c.assetId} (${c.assetName})`,
    inApp: `${c.assetName} (${c.assetId}) is ${c.availableQuantity <= 0 ? 'out of stock' : `low on stock — ${c.availableQuantity} left`} (reorder at ${c.reorderLevel})`,
    email:
      `An inventory item has reached its reorder level.\n\n` +
      `Asset ID:        ${c.assetId}\n` +
      `Asset name:      ${c.assetName}\n` +
      `Category:        ${c.category || 'N/A'}\n` +
      `Location:        ${c.location || 'N/A'}\n` +
      `Available:       ${c.availableQuantity}\n` +
      `Reorder level:   ${c.reorderLevel}\n\n` +
      `Recommended action: raise a purchase order to replenish stock before it runs out.\n\n— AssetFlow Monitoring`,
    sms: `AssetFlow: ${c.assetId} (${c.assetName}) low stock - ${c.availableQuantity} left (reorder at ${c.reorderLevel})`
  }),

  /* ------------------------------------------------------------- finance */

  'finance.payment_pending': (c) => ({
    type: 'warning',
    subject: `Payment pending: invoice ${c.invoiceId} (${c.vendor})`,
    inApp: `Invoice ${c.invoiceId} from ${c.vendor} has been ${c.status} for ${plural(c.ageDays, 'day')} (${money(c.amount)})`,
    email:
      `An invoice payment is still outstanding.\n\n` +
      `Invoice:   ${c.invoiceId}\n` +
      `Vendor:    ${c.vendor}\n` +
      `Amount:    ${money(c.amount)}\n` +
      `Status:    ${c.status}\n` +
      `Dated:     ${fmtDate(c.date)}\n` +
      `Outstanding for: ${plural(c.ageDays, 'day')}\n\n` +
      `Recommended action: process the payment or update the invoice status.\n\n— AssetFlow Finance`,
    sms: `AssetFlow: invoice ${c.invoiceId} (${c.vendor}) ${money(c.amount)} still ${c.status} after ${plural(c.ageDays, 'day')}`
  }),

  'finance.invoice_created': (c) => ({
    type: 'info',
    subject: `Invoice ${c.invoiceId} recorded (${c.vendor})`,
    inApp: `Invoice ${c.invoiceId} from ${c.vendor} recorded for ${money(c.amount)}`,
    email:
      `A purchase invoice has been recorded.\n\n` +
      `Invoice:   ${c.invoiceId}\n` +
      `Vendor:    ${c.vendor}\n` +
      `Amount:    ${money(c.amount)}\n` +
      `PO:        ${c.poReference || 'not referenced'}\n` +
      `Status:    ${c.paymentStatus}\n` +
      `Recorded by: ${c.actor}\n\n— AssetFlow Finance`,
    sms: `AssetFlow: invoice ${c.invoiceId} (${c.vendor}) ${money(c.amount)} recorded`
  }),

  'finance.invoice_overdue': (c) => ({
    type: 'error',
    subject: `OVERDUE: invoice ${c.invoiceId} (${c.vendor})`,
    inApp: `Invoice ${c.invoiceId} from ${c.vendor} is now OVERDUE (${money(c.amount)})`,
    email:
      `An invoice has been marked overdue.\n\n` +
      `Invoice:  ${c.invoiceId}\n` +
      `Vendor:   ${c.vendor}\n` +
      `Amount:   ${money(c.amount)}\n` +
      `Dated:    ${fmtDate(c.date)}\n\n` +
      `Recommended action: settle or dispute before the vendor escalates.\n\n— AssetFlow Finance`,
    sms: `AssetFlow: invoice ${c.invoiceId} (${c.vendor}) is OVERDUE - ${money(c.amount)}`
  }),

  /* -------------------------------------------------------- user account */

  'user.created': (c) => ({
    type: 'info',
    subject: `New account: ${c.name} (${c.role})`,
    inApp: `${c.actor} created an account for ${c.name} (${c.role})`,
    email:
      `A user account has been created.\n\n` +
      `Name:       ${c.name}\n` +
      `Email:      ${c.email}\n` +
      `Role:       ${c.role}\n` +
      `Department: ${c.department || 'unassigned'}\n` +
      `Created by: ${c.actor}\n\n— AssetFlow Directory`,
    sms: `AssetFlow: account created for ${c.name} (${c.role}) by ${c.actor}`
  }),

  'user.role_changed': (c) => ({
    type: 'warning',
    subject: `Role change: ${c.name} is now ${c.newRole}`,
    inApp: `${c.actor} changed ${c.name}'s role from ${c.previousRole} to ${c.newRole}`,
    email:
      `A user's role has changed. Roles grant permissions, so this is worth reviewing.\n\n` +
      `User:       ${c.name} (${c.email})\n` +
      `Previously: ${c.previousRole}\n` +
      `Now:        ${c.newRole}\n` +
      `Changed by: ${c.actor}\n\n— AssetFlow Directory`,
    sms: `AssetFlow: ${c.name} role ${c.previousRole} -> ${c.newRole} (by ${c.actor})`
  }),

  'user.deleted': (c) => ({
    type: 'warning',
    subject: `Account removed: ${c.name}`,
    inApp: `${c.actor} removed the account for ${c.name} (${c.role})`,
    email:
      `A user account has been removed. Any assets they held are now unassigned.\n\n` +
      `Name:       ${c.name}\n` +
      `Email:      ${c.email}\n` +
      `Role:       ${c.role}\n` +
      `Removed by: ${c.actor}\n\n— AssetFlow Directory`,
    sms: `AssetFlow: account ${c.email} removed by ${c.actor}`
  }),

  /* ----------------------------------------------------------- security */

  'security.password_changed': (c) => ({
    type: 'warning',
    subject: `Password changed for ${c.email}`,
    inApp: `Password changed for ${c.email}`,
    email:
      `The password for an account has been changed.\n\n` +
      `Account: ${c.email}\n` +
      `When:    ${c.at}\n\n` +
      `If this was not expected, treat the account as compromised and reset it.\n\n— AssetFlow Security`,
    sms: `AssetFlow: password changed for ${c.email}`
  }),

  'security.permissions_changed': (c) => ({
    type: 'error',
    subject: `Role permissions changed by ${c.actor}`,
    inApp: `${c.actor} changed role permissions: ${c.summary}`,
    email:
      `Role permissions have been changed. This alters what every user of those roles ` +
      `can do.\n\n` +
      `Changed by: ${c.actor}\n` +
      `Roles:      ${c.summary}\n\n— AssetFlow Security`,
    sms: `AssetFlow: role permissions changed by ${c.actor} (${c.summary})`
  }),

  /* ------------------------------------------------------------- system */

  /* ----------------------------------------------------------- requests */
  // One set of templates for every request type. The type's own label carries the
  // specifics ("Purchase Order Edit Request", "Asset Disposal Request"), so a new
  // workflow added to the registry is notified correctly without a template here.

  'request.submitted': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] ${c.requestTypeLabel} submitted for approval`,
    inApp: `${c.requestId}: your ${c.requestTypeLabel} for ${c.recordLabel} is awaiting approval`,
    email:
      `Your request has been submitted and is now awaiting approval.\n\n` +
      `Request:   ${c.requestId}\n` +
      `Type:      ${c.requestTypeLabel}\n` +
      `Record:    ${c.recordLabel}\n` +
      `Priority:  ${c.priority}\n` +
      `Reason:    ${c.reason}\n` +
      `Changes:   ${changeList(c.changes)}\n` +
      `Approval:  level 1 of ${c.totalLevels}\n\n` +
      `The record stays unchanged until the request is approved.\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} (${c.requestTypeLabel}) submitted for approval`
  }),

  'request.approval_requested': (c) => ({
    type: c.priority === 'Critical' ? 'error' : c.priority === 'High' ? 'warning' : 'info',
    subject: `[${c.requestId}] Your approval is needed: ${c.requestTypeLabel}`,
    inApp: `${c.requestId}: ${c.requestedByName} needs your approval on ${c.recordLabel}`,
    email:
      `A request needs your approval.\n\n` +
      `Request:     ${c.requestId}\n` +
      `Type:        ${c.requestTypeLabel}\n` +
      `Record:      ${c.recordLabel}\n` +
      `Raised by:   ${c.requestedByName}\n` +
      `Priority:    ${c.priority}\n` +
      `Reason:      ${c.reason}\n` +
      `${c.dueDate ? `Due by:      ${fmtDate(c.dueDate)}\n` : ''}` +
      `Approval:    level ${c.currentLevel} of ${c.totalLevels}\n\n` +
      `Proposed changes:\n${changeBlock(c.changes)}\n\n` +
      `Open the Requests module to compare the current and proposed values before deciding.\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} (${c.requestTypeLabel}, ${c.recordLabel}) needs your approval`
  }),

  'request.assigned': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] Assigned to you for approval`,
    inApp: `${c.requestId} (${c.requestTypeLabel}) has been assigned to you at level ${c.currentLevel}`,
    email:
      `A request has been reassigned to you for approval.\n\n` +
      `Request:  ${c.requestId}\n` +
      `Type:     ${c.requestTypeLabel}\n` +
      `Record:   ${c.recordLabel}\n` +
      `Level:    ${c.currentLevel} of ${c.totalLevels}\n` +
      `Reason:   ${c.reason}\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} assigned to you for approval`
  }),

  'request.approved': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] Approved — changes applied`,
    inApp: `${c.requestId} (${c.requestTypeLabel}) was approved and applied to ${c.recordLabel}`,
    email:
      `A request has been fully approved and its changes are now live on the record.\n\n` +
      `Request:  ${c.requestId}\n` +
      `Type:     ${c.requestTypeLabel}\n` +
      `Record:   ${c.recordLabel}\n` +
      `Raised by: ${c.requestedByName}\n\n` +
      `Applied changes:\n${changeBlock(c.appliedChanges && c.appliedChanges.length ? c.appliedChanges : c.changes)}\n\n` +
      `— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} approved, changes applied to ${c.recordLabel}`
  }),

  'request.rejected': (c) => ({
    type: 'warning',
    subject: `[${c.requestId}] Rejected`,
    inApp: `${c.requestId} (${c.requestTypeLabel}) was rejected — no changes were made`,
    email:
      `A request has been rejected. The record is unchanged.\n\n` +
      `Request:  ${c.requestId}\n` +
      `Type:     ${c.requestTypeLabel}\n` +
      `Record:   ${c.recordLabel}\n` +
      `Reason given: ${c.comment || 'none'}\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} rejected - no changes made`
  }),

  'request.cancelled': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] Cancelled`,
    inApp: `${c.requestId} (${c.requestTypeLabel}) was cancelled`,
    email:
      `A request has been cancelled. The record is unchanged.\n\n` +
      `Request: ${c.requestId}\n` +
      `Type:    ${c.requestTypeLabel}\n` +
      `Record:  ${c.recordLabel}\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} cancelled`
  }),

  'request.info_requested': (c) => ({
    type: 'warning',
    subject: `[${c.requestId}] More information needed`,
    inApp: `${c.requestId}: an approver needs more information before deciding`,
    email:
      `An approver has asked for more information before deciding on your request.\n\n` +
      `Request: ${c.requestId}\n` +
      `Type:    ${c.requestTypeLabel}\n` +
      `Record:  ${c.recordLabel}\n\n` +
      `What is needed:\n${c.comment}\n\n` +
      `Reply on the request, attach anything relevant, and send it back for approval.\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} - approver needs more information`
  }),

  'request.comment_added': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] New comment from ${c.authorName}`,
    inApp: `${c.authorName} commented on ${c.requestId}`,
    email:
      `${c.authorName} commented on request ${c.requestId} (${c.requestTypeLabel}, ${c.recordLabel}):\n\n` +
      `${c.comment}\n\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.authorName} commented on ${c.requestId}`
  }),

  // An approved request became another record — today a purchase order raised from a
  // purchase request. Kept generic like the rest: the type's label and the outcome text
  // carry the specifics, so a future conversion needs no template of its own.
  'request.converted': (c) => ({
    type: 'info',
    subject: `[${c.requestId}] ${c.outcomeLabel} raised`,
    inApp: `${c.requestId} became ${c.outcomeLabel}`,
    email:
      `An approved request has been converted.\n\n` +
      `Request:  ${c.requestId}\n` +
      `Type:     ${c.requestTypeLabel}\n` +
      `Details:  ${c.recordLabel}\n` +
      `Raised by: ${c.requestedByName}\n` +
      `Outcome:  ${c.outcomeLabel}\n` +
      `${c.outcomeDetail ? `${c.outcomeDetail}\n` : ''}` +
      `\n— AssetFlow Requests`,
    sms: `AssetFlow: ${c.requestId} converted to ${c.outcomeLabel}`
  }),

  'system.bulk_import_completed': (c) => ({
    type: c.failed > 0 ? 'warning' : 'info',
    subject: `Bulk ${c.kind} import finished: ${c.success} of ${c.total}`,
    inApp: `Bulk ${c.kind} import: ${c.success} imported, ${c.failed} failed, ${c.duplicate} duplicate`,
    email:
      `A bulk ${c.kind} import has finished.\n\n` +
      `Total rows: ${c.total}\n` +
      `Imported:   ${c.success}\n` +
      `Failed:     ${c.failed}\n` +
      `Duplicate:  ${c.duplicate}\n` +
      `Run by:     ${c.actor}\n\n— AssetFlow`,
    sms: `AssetFlow: ${c.kind} import done - ${c.success}/${c.total} ok, ${c.failed} failed`
  })
};

/** Renders one event. Throws on an unknown type rather than silently sending nothing. */
function render(eventType, ctx) {
  const template = templates[eventType];
  if (!template) throw new Error(`No notification template for event type "${eventType}"`);
  return template(ctx);
}

module.exports = { render, eventTypes: Object.keys(templates) };
