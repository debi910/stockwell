# Stockwell

Billing, accounts, stock and GST for an FMCG distributorship. It works offline on Windows, and its screens and keys follow TallyPrime, so staff who know Tally can use it on day one.

Built for a distributor in Bhubaneswar, Odisha, that handles Patanjali, Parag Milk Foods and ITC Sunrise Masala. Free and not for sale.

## What it does

- **Tally-style keyboard flow.** Gateway menu with hot letters. F4 Contra, F5 Payment, F6 Receipt, F7 Journal, F8 Sales, F9 Purchase, Ctrl+F8 Credit Note, Ctrl+F9 Debit Note. Enter moves to the next field, Ctrl+A saves, Alt+C creates a master from inside a voucher, Esc goes back, F2 changes the date.
- **Masters.** The same 28 groups as Tally, plus ledgers (GSTIN, credit days, beat, salesman, MSME flags), stock items (HSN, GST rate, MRP, schemes such as "buy 10 get 1 free", batch and expiry tracking), stock groups (one per company you distribute for) and units.
- **Vouchers.** GST invoices work out CGST and SGST, or IGST, from the party's state. Bills round to the rupee, batches are picked soonest-expiry first (FEFO), and scheme free quantity is filled in by itself. Receipts and payments are tracked bill by bill.
- **Reports.** Day Book, Trial Balance, Profit & Loss, Balance Sheet, Ledger, Stock Summary, Outstandings with ageing, and an Edit Log of every change and who made it.
- **Extras Tally does not have:**
  - Sending a bill on WhatsApp: Alt+W saves the bill as a PDF and opens the party's chat with the message typed in.
  - Payment reminders on WhatsApp, from Alerts & Reminders.
  - A UPI QR code printed on every bill.
  - MSME late-payment alerts in both directions: money owed to you with interest, and the 45-day Section 43B(h) deadline for paying MSME suppliers.
  - Alerts for stock near expiry and items at reorder level.
- **GST, the free way.** Stockwell makes the GSTR-1 file and the bulk e-Way Bill file, and shows the GSTR-3B figures. You upload the files on the government portals yourself, which costs nothing.
- **Import from Tally.** Groups, ledgers with opening balances, units, stock groups and items, either live from TallyPrime on port 9000 or from an exported XML file.
- **Two or more PCs, one set of books.** See below.
- **User logins.** An **Owner** can do everything. A **Billing operator** can make bills, receipts and payments, and create parties and items, but cannot delete, cancel, change entries from earlier days, alter masters, or see Profit & Loss, Balance Sheet, Trial Balance or the Edit Log. The server checks these rules, not just the screens.

## Installing

1. Download **Stockwell-Setup.exe** from the latest run of the CI workflow (Actions → CI → *Stockwell-Setup* artifact). Releases will carry it later.
2. Run it. The installer is not code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

### The main PC (where the books live)

1. Open Stockwell and choose **This is the main PC**.
2. When Windows Firewall asks, tick **Private networks** and click **Allow**. This lets the second PC reach the books.
3. Press F3 (Company) and fill in the name, GSTIN, UPI ID and a **backup folder**. A pen drive or a Google Drive folder is best. Stockwell backs up once a day and when it closes, and keeps the last 30 copies.
4. The bottom-left corner shows this PC's address, for example `Main PC · others connect to 192.168.1.10:7400`.

### The second PC

1. Open Stockwell and choose **Connect to the main PC**.
2. Type the main PC's address (for example `192.168.1.10`) and press Enter.
3. The main PC must be on with Stockwell open. This is the same as TallyPrime Gold, where the PC running the server must be on.

Tip: in the router settings, give the main PC a fixed IP address (a "DHCP reservation") so the address never changes.

To change a PC's setup later, click the address in the bottom-left corner.

### Logins

Until you create a user, Stockwell opens without asking for a password. When you are ready, go to F3 (Company) → **Users and passwords**. Create the Owner first, then add Billing operators.

## Filing GST with Stockwell files

**GSTR-1 (by the 11th):** Gateway → G (GST Returns), pick the month, then press **Save GSTR-1 file**. On gst.gov.in go to Returns Dashboard, choose the month, then GSTR-1 → Prepare Offline → Upload. Wait for "Processed", then Prepare Online → Generate Summary → File with EVC.

**GSTR-3B (by the 20th):** Open the GSTR-3B tab and type the figures into the portal. Check input tax credit against GSTR-2B first.

**e-Way Bills:** Odisha needs one for goods over ₹50,000 moving within the state. Bills over the limit show a tag. Fill in the vehicle number and distance on the bill. In GST Returns → e-Way Bills, tick the bills and save the file. On ewaybillgst.gov.in go to e-Waybill → Generate Bulk and upload it. Then type the EWB number back next to the bill.

## Sending bills on WhatsApp

Install **WhatsApp Desktop** on the PC and log in with the firm's number. On a saved bill, press **Alt+W**. Stockwell saves the PDF to `Documents\Stockwell\Bills`, opens that folder, and opens the party's chat with the message ready. Drag the PDF into the chat and press Send.

WhatsApp does not let free apps attach files automatically. Sending fully automatically would need the paid WhatsApp Business API.

## Moving from TallyPrime

1. In TallyPrime press F1 (Help) → Settings → Connectivity. Set "TallyPrime acts as" to **Both** and Port to **9000**, and keep the company open.
2. In Stockwell go to Gateway → I (Import from Tally) → **Import from Tally**.
3. Check that Stockwell's Trial Balance matches Tally's for opening balances.
4. Run both side by side for a few days before switching.

## For developers

```bash
npm install
npm run dev:server     # API on :7400 with a dev database in .data/
npm run dev:ui         # screens on :5173
npm test               # maths, books, GST and user-rule tests
npm run test:e2e       # keyboard-driven billing day in a real browser
npm run dist           # Windows installer into release/ (run on Windows or in CI)
```

The project is laid out as follows:

- `src/core`: money (in paise), GST, and date maths
- `src/server`: Fastify, SQLite (better-sqlite3), the books, reports, GST files, Tally import and logins
- `src/ui`: React screens
- `electron`: the Windows app shell, main/second PC setup, PDF saving and daily backup
