
const DB_NAME = "MyFinanceDB";
const DB_VERSION = 2;

let db;

// Indian currency format
function money(amount) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2
    }).format(amount);
}

function today() {
    const date = new Date();

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function roundMoney(amount) {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
}

// Open IndexedDB
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {
            const database = event.target.result;

            if (!database.objectStoreNames.contains("income")) {
                database.createObjectStore("income", {
                    keyPath: "id",
                    autoIncrement: true
                });
            }

            if (!database.objectStoreNames.contains("expenses")) {
                database.createObjectStore("expenses", {
                    keyPath: "id",
                    autoIncrement: true
                });
            }

            if (!database.objectStoreNames.contains("splits")) {
                database.createObjectStore("splits", {
                    keyPath: "id",
                    autoIncrement: true
                });
            }

            if (!database.objectStoreNames.contains("settlementPayments")) {
                database.createObjectStore("settlementPayments", {
                    keyPath: "id",
                    autoIncrement: true
                });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Get all records
function getAll(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Calculate payments made against a split
function getPaidAmount(splitId, payments) {
    return roundMoney(
        payments
            .filter(payment => payment.splitId === splitId)
            .reduce((sum, payment) => sum + payment.amount, 0)
    );
}

// Calculate outstanding amount
function getOutstanding(split, payments) {
    const paid = getPaidAmount(split.id, payments);

    return Math.max(0, roundMoney(split.amount - paid));
}

// Add income
document.getElementById("incomeForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const source = document.getElementById("incomeSource").value.trim();
    const amount = Number(document.getElementById("incomeAmount").value);
    const date = document.getElementById("incomeDate").value;
    const notes = document.getElementById("incomeNotes").value.trim();

    if (!source || !Number.isFinite(amount) || amount <= 0 || !date) {
        alert("Please enter valid income details.");
        return;
    }

    const transaction = db.transaction("income", "readwrite");

    transaction.objectStore("income").add({
        source,
        amount: roundMoney(amount),
        date,
        notes
    });

    transaction.oncomplete = async () => {
        event.target.reset();
        document.getElementById("incomeDate").value = today();

        await refreshDashboard();

        alert("Income added successfully!");
    };

    transaction.onerror = () => alert("Could not save income.");
});

// Add regular expense
document.getElementById("expenseForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const category = document.getElementById("expenseCategory").value;
    const description = document.getElementById("expenseDescription").value.trim();
    const amount = Number(document.getElementById("expenseAmount").value);
    const date = document.getElementById("expenseDate").value;

    if (!category || !Number.isFinite(amount) || amount <= 0 || !date) {
        alert("Please enter valid expense details.");
        return;
    }

    const transaction = db.transaction("expenses", "readwrite");

    transaction.objectStore("expenses").add({
        category,
        description,
        amount: roundMoney(amount),
        date,
        isSplit: false
    });

    transaction.oncomplete = async () => {
        event.target.reset();
        document.getElementById("expenseDate").value = today();

        await refreshDashboard();

        alert("Expense added successfully!");
    };

    transaction.onerror = () => alert("Could not save expense.");
});

// Add shared expense: Friend owes me
document.getElementById("splitForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const person = document.getElementById("personName").value.trim();
    const description = document.getElementById("splitDescription").value.trim();
    const totalAmount = Number(document.getElementById("splitAmount").value);
    const date = document.getElementById("splitDate").value;

    if (!person || !Number.isFinite(totalAmount) || totalAmount <= 0 || !date) {
        alert("Please enter valid shared expense details.");
        return;
    }

    const myShare = roundMoney(totalAmount / 2);
    const theirShare = roundMoney(totalAmount - myShare);

    const transaction = db.transaction(
        ["expenses", "splits"],
        "readwrite"
    );

    const expenseStore = transaction.objectStore("expenses");
    const splitStore = transaction.objectStore("splits");

    const expenseRequest = expenseStore.add({
        category: "Shared Expense",
        description: description || "Shared with " + person,
        amount: myShare,
        date,
        isSplit: true
    });

    expenseRequest.onsuccess = function () {
        splitStore.add({
            person,
            description: description || "Shared expense",
            amount: theirShare,
            date,
            direction: "receivable",
            expenseId: expenseRequest.result
        });
    };

    transaction.oncomplete = async () => {
        event.target.reset();
        document.getElementById("splitDate").value = today();

        await refreshDashboard();

        alert("Shared expense added successfully!");
    };

    transaction.onerror = () => alert("Could not save shared expense.");
});

// Add shared expense: I owe friend
document.getElementById("payableForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const person = document.getElementById("debtPersonName").value.trim();
    const description = document.getElementById("debtDescription").value.trim();
    const totalAmount = Number(document.getElementById("debtAmount").value);
    const date = document.getElementById("debtDate").value;

    if (!person || !Number.isFinite(totalAmount) || totalAmount <= 0 || !date) {
        alert("Please enter valid debt details.");
        return;
    }

    const myShare = roundMoney(totalAmount / 2);

    const transaction = db.transaction("splits", "readwrite");

    transaction.objectStore("splits").add({
        person,
        description: description || "Shared expense",
        amount: myShare,
        date,
        direction: "payable"
    });

    transaction.oncomplete = async () => {
        event.target.reset();
        document.getElementById("debtDate").value = today();

        await refreshDashboard();

        alert("Your debt has been recorded!");
    };

    transaction.onerror = () => alert("Could not save debt.");
});

// Record a collection or repayment
async function recordSettlement(splitId) {
    const splits = await getAll("splits");
    const payments = await getAll("settlementPayments");

    const split = splits.find(item => item.id === splitId);

    if (!split) {
        alert("Settlement record not found.");
        return;
    }

    const remaining = getOutstanding(split, payments);

    if (remaining <= 0) {
        alert("This settlement is already completed.");
        return;
    }

    const isPayable = split.direction === "payable";
    const action = isPayable ? "repay" : "collect";

    const amountText = prompt(
        `Enter amount to ${action} (Remaining: ${money(remaining)})`,
        remaining.toFixed(2)
    );

    if (amountText === null) return;

    const amount = Number(amountText);

    if (!Number.isFinite(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    if (amount > remaining + 0.001) {
        alert("Amount cannot be greater than the outstanding balance.");
        return;
    }

    const paymentDate = prompt(
        "Enter payment date (YYYY-MM-DD):",
        today()
    );

    if (paymentDate === null) return;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
        alert("Please enter the date in YYYY-MM-DD format.");
        return;
    }

    const transaction = db.transaction("settlementPayments", "readwrite");

    transaction.objectStore("settlementPayments").add({
        splitId: split.id,
        person: split.person,
        description: split.description,
        amount: roundMoney(amount),
        date: paymentDate,
        direction: isPayable ? "payable" : "receivable"
    });

    transaction.oncomplete = async () => {
        await refreshDashboard();

        alert(
            isPayable
                ? "Repayment recorded successfully!"
                : "Collection recorded successfully!"
        );
    };

    transaction.onerror = () => {
        alert("Could not record settlement payment.");
    };
}

// Delete a transaction and its linked records
async function deleteTransaction(storeName, id) {
    if (!confirm("Are you sure you want to delete this transaction?")) {
        return;
    }

    if (storeName === "expenses") {
        const transaction = db.transaction(
            ["expenses", "splits", "settlementPayments"],
            "readwrite"
        );

        const expenseStore = transaction.objectStore("expenses");
        const splitStore = transaction.objectStore("splits");
        const paymentStore = transaction.objectStore("settlementPayments");

        expenseStore.delete(id);

        const splitsRequest = splitStore.getAll();
        const paymentsRequest = paymentStore.getAll();

        let linkedSplitIds = null;
        let allPayments = null;

        function cleanLinkedRecords() {
            if (linkedSplitIds === null || allPayments === null) return;

            linkedSplitIds.forEach(splitId => splitStore.delete(splitId));

            allPayments.forEach(payment => {
                if (linkedSplitIds.includes(payment.splitId)) {
                    paymentStore.delete(payment.id);
                }
            });
        }

        splitsRequest.onsuccess = function () {
            linkedSplitIds = splitsRequest.result
                .filter(split => split.expenseId === id)
                .map(split => split.id);

            cleanLinkedRecords();
        };

        paymentsRequest.onsuccess = function () {
            allPayments = paymentsRequest.result;
            cleanLinkedRecords();
        };

        transaction.oncomplete = refreshDashboard;
        transaction.onerror = () => alert("Could not delete the transaction.");

    } else if (storeName === "splits") {
        const transaction = db.transaction(
            ["splits", "settlementPayments"],
            "readwrite"
        );

        transaction.objectStore("splits").delete(id);

        const paymentStore = transaction.objectStore("settlementPayments");
        const request = paymentStore.getAll();

        request.onsuccess = function () {
            request.result.forEach(payment => {
                if (payment.splitId === id) {
                    paymentStore.delete(payment.id);
                }
            });
        };

        transaction.oncomplete = refreshDashboard;

    } else {
        const transaction = db.transaction(storeName, "readwrite");

        transaction.objectStore(storeName).delete(id);

        transaction.oncomplete = refreshDashboard;
    }
}

// Edit a transaction
async function editTransaction(storeName, id) {
    const records = await getAll(storeName);
    const record = records.find(item => item.id === id);

    if (!record) return;

    const payments = await getAll("settlementPayments");

    const newDescription = prompt(
        "Enter description/source:",
        record.description || record.source || record.category
    );

    if (newDescription === null) return;

    const newAmountText = prompt("Enter amount:", record.amount);

    if (newAmountText === null) return;

    const newAmount = Number(newAmountText);

    if (!Number.isFinite(newAmount) || newAmount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    const newDate = prompt("Enter date (YYYY-MM-DD):", record.date);

    if (newDate === null) return;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        alert("Please enter the date in YYYY-MM-DD format.");
        return;
    }

    if (storeName === "splits") {
        const alreadyPaid = getPaidAmount(id, payments);

        if (newAmount < alreadyPaid) {
            alert("The new amount cannot be less than the amount already settled.");
            return;
        }
    }

    const stores = storeName === "expenses"
        ? ["expenses", "splits", "settlementPayments"]
        : [storeName];

    const transaction = db.transaction(stores, "readwrite");

    const store = transaction.objectStore(storeName);

    if (storeName === "income") {
        record.source = newDescription;
    } else {
        record.description = newDescription;
    }

    record.amount = roundMoney(newAmount);
    record.date = newDate;

    store.put(record);

    // Update linked receivable when editing a shared expense
    if (storeName === "expenses" && record.isSplit) {
        const splitStore = transaction.objectStore("splits");
        const request = splitStore.getAll();

        request.onsuccess = function () {
            request.result.forEach(split => {
                if (split.expenseId === id) {
                    const paid = getPaidAmount(split.id, payments);

                    if (newAmount < paid) {
                        alert("Cannot reduce this expense below the amount already collected.");
                        transaction.abort();
                        return;
                    }

                    split.amount = roundMoney(newAmount);
                    split.description = newDescription;
                    split.date = newDate;

                    splitStore.put(split);
                }
            });
        };
    }

    transaction.oncomplete = refreshDashboard;
    transaction.onerror = () => alert("Could not update transaction.");
}

// Prevent descriptions from being treated as HTML
function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

// Render settlement list
function renderSettlements(splits, payments) {
    const list = document.getElementById("settlementList");

    if (!list) return;

    if (splits.length === 0) {
        list.innerHTML = "<p>No settlements recorded yet.</p>";
        return;
    }

    const sortedSplits = [...splits].sort((a, b) =>
        b.date.localeCompare(a.date) || b.id - a.id
    );

    list.innerHTML = sortedSplits.map(split => {
        const paid = getPaidAmount(split.id, payments);
        const remaining = getOutstanding(split, payments);
        const isPayable = split.direction === "payable";

        const percentage = split.amount > 0
            ? Math.min(100, (paid / split.amount) * 100)
            : 100;

        const status = remaining <= 0
            ? "Settled"
            : paid > 0
                ? "Partially settled"
                : "Pending";

        const statusColor = remaining <= 0
            ? "#16a34a"
            : paid > 0
                ? "#d97706"
                : "#64748b";

        return `
            <div class="transaction-item settlement-item">

                <div>
                    <strong>${escapeHTML(split.person)}</strong>

                    <p>
                        ${escapeHTML(split.description || "Shared expense")}
                    </p>

                    <p>
                        ${isPayable ? "You owe" : "Friend owes you"}
                        · ${escapeHTML(split.date)}
                    </p>

                    <p>Original amount: ${money(split.amount)}</p>

                    <p>Settled: ${money(paid)}</p>

                    <strong>Remaining: ${money(remaining)}</strong>

                    <p style="color:${statusColor};">${status}</p>

                    <div style="
                        background:#e5e7eb;
                        height:8px;
                        border-radius:10px;
                        overflow:hidden;
                        margin-top:8px;
                        max-width:250px;
                    ">
                        <div style="
                            background:#16a34a;
                            height:8px;
                            width:${percentage}%;
                        "></div>
                    </div>

                    <small>${Math.round(percentage)}% settled</small>
                </div>

                <div>
                    ${
                        remaining > 0
                            ? `<button type="button"
                                onclick="recordSettlement(${split.id})">
                                ${isPayable ? "Record Repayment" : "Record Collection"}
                               </button>`
                            : `<strong style="color:#16a34a;">Completed</strong>`
                    }

                    <button type="button"
                        onclick="deleteTransaction('splits', ${split.id})">
                        Delete
                    </button>
                </div>

            </div>
        `;
    }).join("");
}

// Refresh dashboard
async function refreshDashboard() {
    const incomes = await getAll("income");
    const expenses = await getAll("expenses");
    const splits = await getAll("splits");
    const payments = await getAll("settlementPayments");

    const totalIncome = incomes.reduce(
        (sum, item) => sum + item.amount, 0
    );

    const totalExpenses = expenses.reduce(
        (sum, item) => sum + item.amount, 0
    );

    const receivable = splits
        .filter(item => item.direction !== "payable")
        .reduce(
            (sum, item) => sum + getOutstanding(item, payments),
            0
        );

    const payable = splits
        .filter(item => item.direction === "payable")
        .reduce(
            (sum, item) => sum + getOutstanding(item, payments),
            0
        );

    const repayments = payments
        .filter(item => item.direction === "payable")
        .reduce((sum, item) => sum + item.amount, 0);

    const balance = roundMoney(
        totalIncome - totalExpenses - receivable - repayments
    );

    document.getElementById("balance").textContent = money(balance);
    document.getElementById("income").textContent = money(totalIncome);
    document.getElementById("expenses").textContent = money(totalExpenses);
    document.getElementById("receivable").textContent = money(receivable);
    document.getElementById("payable").textContent = money(payable);

    renderSettlements(splits, payments);
    renderTransactions(incomes, expenses, splits, payments);

    renderInsights(incomes, expenses, splits, payments);
}


// -------------------- INSIGHTS DASHBOARD --------------------

function monthKey(dateValue) {
    return String(dateValue || "").slice(0, 7);
}

function monthLabel(monthValue) {
    if (!/^\d{4}-\d{2}$/.test(monthValue)) return monthValue;

    const [year, month] = monthValue.split("-").map(Number);

    return new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric"
    });
}

function totalForMonth(records, selectedMonth) {
    return records
        .filter(item => monthKey(item.date) === selectedMonth)
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

// Build chart categories using personal expenses and outstanding settlements.
// Settlement amounts remain separate from actual spending totals.
function getChartCategoryTotals(expenses, splits, payments, selectedMonth) {
    const totals = {};

    expenses
        .filter(item =>
            monthKey(item.date) === selectedMonth &&
            !item.isSplit
        )
        .forEach(item => {
            const category = item.category || "Other";

            totals[category] = (totals[category] || 0) +
                Number(item.amount || 0);
        });

    splits
        .filter(item => monthKey(item.date) === selectedMonth)
        .forEach(split => {
            const outstanding = getOutstanding(split, payments);

            if (outstanding <= 0) return;

            const category = split.direction === "payable"
                ? "I Owe"
                : "Owed By Me";

            totals[category] = (totals[category] || 0) + outstanding;
        });

    return totals;
}

// Main Insights renderer
function renderInsights(incomes, expenses, splits = [], payments = []) {
    const monthInput = document.getElementById("insightsMonth");

    if (!monthInput) return;

    const selectedMonth = monthInput.value || today().slice(0, 7);

    const monthlyIncome = roundMoney(
        totalForMonth(incomes, selectedMonth)
    );

    const monthlyExpenses = roundMoney(
        totalForMonth(expenses, selectedMonth)
    );

    const savings = roundMoney(monthlyIncome - monthlyExpenses);

    const savingsRate = monthlyIncome > 0
        ? (savings / monthlyIncome) * 100
        : 0;

    const incomeElement = document.getElementById("insightIncome");
    const expenseElement = document.getElementById("insightExpenses");
    const savingsElement = document.getElementById("insightSavings");
    const rateElement = document.getElementById("insightSavingsRate");

    if (incomeElement) incomeElement.textContent = money(monthlyIncome);
    if (expenseElement) expenseElement.textContent = money(monthlyExpenses);
    if (savingsElement) savingsElement.textContent = money(savings);
    if (rateElement) rateElement.textContent = savingsRate.toFixed(1) + "%";

    renderCategoryBreakdown(expenses, splits, payments, selectedMonth);
    renderIncomeExpenseChart(monthlyIncome, monthlyExpenses);
    renderMonthlyTrend(incomes, expenses, selectedMonth);

    createExtraChartContainers();

    renderExpenseDonut(expenses, splits, payments, selectedMonth);
    renderDailySpending(expenses, selectedMonth);
    renderSavingsTrend(incomes, expenses, selectedMonth);
}

// Category breakdown
function renderCategoryBreakdown(expenses, splits, payments, selectedMonth) {
    const container = document.getElementById("categoryBreakdown");

    if (!container) return;

    const categoryTotals = getChartCategoryTotals(
        expenses,
        splits,
        payments,
        selectedMonth
    );

    const entries = Object.entries(categoryTotals)
        .sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
        container.innerHTML = "<p>No expenses or settlements recorded for this month.</p>";
        return;
    }

    const highest = Math.max(...entries.map(([, amount]) => amount), 1);

    container.innerHTML = entries.map(([category, amount]) => {
        const percentage = (amount / highest) * 100;

        return `
            <div class="insight-row">
                <div class="insight-row-heading">
                    <strong>${escapeHTML(category)}</strong>
                    <span>${money(amount)}</span>
                </div>

                <div class="insight-bar">
                    <div class="insight-bar-fill"
                        style="width:${percentage.toFixed(1)}%">
                    </div>
                </div>
            </div>
        `;
    }).join("");

    container.insertAdjacentHTML(
        "beforeend",
        `<small style="display:block;margin-top:12px;color:#64748b;">
            I Owe and Owed By Me show outstanding settlement amounts.
            They are not included in actual expense totals.
        </small>`
    );
}

// Income vs Expenses chart
function renderIncomeExpenseChart(monthlyIncome, monthlyExpenses) {
    const container = document.getElementById("incomeExpenseChart");

    if (!container) return;

    const maximum = Math.max(monthlyIncome, monthlyExpenses, 1);

    const incomeHeight = Math.max(2, (monthlyIncome / maximum) * 100);
    const expenseHeight = Math.max(2, (monthlyExpenses / maximum) * 100);

    container.innerHTML = `
        <div class="insight-chart-bars">

            <div class="insight-chart-column">
                <strong>${money(monthlyIncome)}</strong>

                <div class="insight-chart-bar-track">
                    <div class="insight-chart-income"
                        style="height:${incomeHeight}%">
                    </div>
                </div>

                <span>Income</span>
            </div>

            <div class="insight-chart-column">
                <strong>${money(monthlyExpenses)}</strong>

                <div class="insight-chart-bar-track">
                    <div class="insight-chart-expense"
                        style="height:${expenseHeight}%">
                    </div>
                </div>

                <span>Expenses</span>
            </div>

        </div>
    `;
}

// Monthly spending trend
function renderMonthlyTrend(incomes, expenses, selectedMonth) {
    const container = document.getElementById("monthlyTrend");

    if (!container) return;

    const [selectedYear, selectedMonthNumber] = selectedMonth
        .split("-")
        .map(Number);

    const months = [];

    for (let offset = 5; offset >= 0; offset--) {
        const date = new Date(
            selectedYear,
            selectedMonthNumber - 1 - offset,
            1
        );

        const key = `${date.getFullYear()}-${String(
            date.getMonth() + 1
        ).padStart(2, "0")}`;

        months.push({
            key,
            label: date.toLocaleDateString("en-IN", {
                month: "short"
            }),
            income: roundMoney(totalForMonth(incomes, key)),
            expenses: roundMoney(totalForMonth(expenses, key))
        });
    }

    const maximum = Math.max(
        ...months.flatMap(item => [item.income, item.expenses]),
        1
    );

    container.innerHTML = months.map(item => {
        const incomeWidth = (item.income / maximum) * 100;
        const expenseWidth = (item.expenses / maximum) * 100;

        return `
            <div class="trend-item">

                <div class="trend-label">
                    <strong>${escapeHTML(item.label)}</strong>
                    <span>
                        In: ${money(item.income)} · Out: ${money(item.expenses)}
                    </span>
                </div>

                <div class="insight-bar trend-income-bar">
                    <div class="insight-chart-income"
                        style="width:${incomeWidth.toFixed(1)}%">
                    </div>
                </div>

                <div class="insight-bar trend-expense-bar">
                    <div class="insight-chart-expense"
                        style="width:${expenseWidth.toFixed(1)}%">
                    </div>
                </div>

            </div>
        `;
    }).join("");
}

// Recalculate Insights when month changes
const insightsMonthInput = document.getElementById("insightsMonth");

if (insightsMonthInput) {
    insightsMonthInput.addEventListener("change", async function () {
        const incomes = await getAll("income");
        const expenses = await getAll("expenses");
        const splits = await getAll("splits");
        const payments = await getAll("settlementPayments");

        renderInsights(incomes, expenses, splits, payments);
    });
}


// -------------------- TRANSACTION HISTORY --------------------

function renderTransactions(incomes, expenses, splits, payments) {
    const list = document.getElementById("transactionList");

    const transactions = [
        ...incomes.map(item => ({
            ...item,
            storeName: "income",
            title: item.source,
            type: "Income"
        })),

        ...expenses.map(item => ({
            ...item,
            storeName: "expenses",
            title: item.description || item.category,
            type: "Expense"
        })),

        ...splits
            .filter(item => item.direction === "payable")
            .map(item => ({
                ...item,
                storeName: "splits",
                title: `${item.person} - ${item.description}`,
                type: "I Owe"
            })),

        ...payments.map(item => ({
            ...item,
            storeName: "settlementPayments",
            title: `${item.person} - ${item.description}`,
            type: item.direction === "payable"
                ? "Repayment"
                : "Money Collected"
        }))
    ];

    transactions.sort((a, b) => {
        return b.date.localeCompare(a.date) || b.id - a.id;
    });

    if (transactions.length === 0) {
        list.innerHTML = "<p>No transactions yet. Add your first transaction!</p>";
        return;
    }

    list.innerHTML = transactions.map(item => `
        <div class="transaction-item">

            <div>
                <strong>${escapeHTML(item.title)}</strong>

                <p>
                    ${escapeHTML(item.type)}
                    · ${escapeHTML(item.date)}
                </p>

                <strong>${money(item.amount)}</strong>
            </div>

            <div>
                ${
                    item.storeName !== "settlementPayments"
                        ? `<button type="button"
                            onclick="editTransaction('${item.storeName}', ${item.id})">
                            Edit
                           </button>`
                        : ""
                }

                <button type="button"
                    onclick="deleteTransaction('${item.storeName}', ${item.id})">
                    Delete
                </button>
            </div>

        </div>
    `).join("");
}


// -------------------- PAGE NAVIGATION --------------------

function showPage(pageId) {
    document.querySelectorAll(".page-section").forEach(page => {
        page.classList.remove("active-page");
    });

    const selectedPage = document.getElementById(pageId);

    if (selectedPage) {
        selectedPage.classList.add("active-page");
    }

    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.page === pageId
        );
    });

    closeFormSections();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

// Open one form section at a time
function showSection(sectionId) {
    showPage("home-page");

    document.querySelectorAll(".form-section").forEach(section => {
        section.style.display = "none";
    });

    const selectedSection = document.getElementById(sectionId);

    if (selectedSection) {
        selectedSection.style.display = "block";

        setTimeout(() => {
            selectedSection.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });
        }, 100);
    }
}

// Close all forms
function closeFormSections() {
    document.querySelectorAll(".form-section").forEach(section => {
        section.style.display = "none";
    });
}

// Make functions available to HTML buttons
window.showPage = showPage;
window.showSection = showSection;
window.closeFormSections = closeFormSections;

window.editTransaction = editTransaction;
window.deleteTransaction = deleteTransaction;
window.recordSettlement = recordSettlement;


// -------------------- START APPLICATION --------------------

async function startApp() {
    try {
        db = await openDatabase();

        showPage("home-page");

        [
            "incomeDate",
            "expenseDate",
            "splitDate",
            "debtDate"
        ].forEach(id => {
            const field = document.getElementById(id);

            if (field) {
                field.value = today();
            }
        });

        const insightsMonth = document.getElementById("insightsMonth");

        if (insightsMonth && !insightsMonth.value) {
            insightsMonth.value = today().slice(0, 7);
        }

        await refreshDashboard();

        console.log("My Finance is ready!");

    } catch (error) {
        console.error("Database error:", error);
        alert("Unable to start the finance app. Please refresh the page.");
    }
}


// -------------------- ADDITIONAL INSIGHTS CHARTS --------------------

// Add chart styling automatically
(function addExtraChartStyles() {
    if (document.getElementById("extra-chart-styles")) return;

    const style = document.createElement("style");
    style.id = "extra-chart-styles";

    style.textContent = `
        .extra-chart-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
            margin-top: 18px;
        }

        .extra-chart-card {
            background: var(--card-bg, #ffffff);
            border: 1px solid #e5e7eb;
            border-radius: 14px;
            padding: 18px;
            min-width: 0;
        }

        .extra-chart-card h3 {
            margin: 0 0 16px;
            font-size: 16px;
        }

        .donut-layout {
            display: flex;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
        }

        .donut-chart {
            width: 165px;
            height: 165px;
            border-radius: 50%;
            flex-shrink: 0;
            position: relative;
        }

        .donut-chart::after {
            content: "";
            position: absolute;
            width: 95px;
            height: 95px;
            background: white;
            border-radius: 50%;
            top: 35px;
            left: 35px;
        }

        .donut-legend {
            flex: 1;
            min-width: 120px;
        }

        .donut-legend-item {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin: 9px 0;
            font-size: 13px;
        }

        .donut-legend-name {
            display: flex;
            align-items: center;
            gap: 7px;
        }

        .donut-color {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            display: inline-block;
            flex-shrink: 0;
        }

        .daily-chart {
            display: flex;
            align-items: end;
            gap: 5px;
            height: 180px;
            overflow-x: auto;
            padding: 10px 0;
        }

        .daily-column {
            flex: 1;
            min-width: 18px;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: end;
            align-items: center;
            gap: 5px;
        }

        .daily-bar {
            width: 70%;
            min-height: 2px;
            background: #6366f1;
            border-radius: 5px 5px 0 0;
        }

        .daily-day {
            font-size: 10px;
            color: #64748b;
        }

        .savings-chart {
            display: flex;
            align-items: end;
            gap: 12px;
            height: 180px;
            padding: 10px 0;
        }

        .savings-column {
            flex: 1;
            min-width: 0;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: end;
            align-items: center;
            gap: 6px;
        }

        .savings-bar {
            width: 65%;
            min-height: 2px;
            border-radius: 5px 5px 0 0;
        }

        .savings-positive {
            background: #16a34a;
        }

        .savings-negative {
            background: #ef4444;
        }

        .savings-month {
            font-size: 11px;
            color: #64748b;
        }

        @media(max-width: 650px) {
            .extra-chart-grid {
                grid-template-columns: 1fr;
            }

            .donut-layout {
                justify-content: center;
            }
        }
    `;

    document.head.appendChild(style);
})();


// Create additional chart containers
function createExtraChartContainers() {
    const insights = document.getElementById("insights-section");

    if (!insights) return;

    if (document.getElementById("extraInsightsCharts")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "extraInsightsCharts";
    wrapper.className = "extra-chart-grid";

    wrapper.innerHTML = `
        <div class="extra-chart-card">
            <h3>Expense & Settlement Breakdown</h3>
            <div id="expenseDonutChart"></div>
        </div>

        <div class="extra-chart-card">
            <h3>Daily Spending</h3>
            <div id="dailySpendingChart"></div>
        </div>

        <div class="extra-chart-card">
            <h3>Monthly Savings Trend</h3>
            <div id="savingsTrendChart"></div>
        </div>
    `;

    const monthlyTrend = document.getElementById("monthlyTrend");

    if (monthlyTrend) {
        monthlyTrend.parentElement.after(wrapper);
    } else {
        insights.appendChild(wrapper);
    }
}


// Expense and settlement doughnut chart
function renderExpenseDonut(expenses, splits, payments, selectedMonth) {
    const container = document.getElementById("expenseDonutChart");

    if (!container) return;

    const totals = getChartCategoryTotals(
        expenses,
        splits,
        payments,
        selectedMonth
    );

    const entries = Object.entries(totals)
        .sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
        container.innerHTML = "<p>No expenses or settlements this month.</p>";
        return;
    }

    const colors = [
        "#6366f1",
        "#16a34a",
        "#f59e0b",
        "#ef4444",
        "#06b6d4",
        "#a855f7",
        "#ec4899",
        "#64748b"
    ];

    const total = entries.reduce((sum, item) => sum + item[1], 0);

    let currentAngle = 0;

    const gradients = entries.map((item, index) => {
        const percentage = (item[1] / total) * 100;
        const start = currentAngle;

        currentAngle += percentage;

        return `${colors[index % colors.length]} ${start}% ${currentAngle}%`;
    });

    const legend = entries.map((item, index) => `
        <div class="donut-legend-item">
            <span class="donut-legend-name">
                <span class="donut-color"
                    style="background:${colors[index % colors.length]}">
                </span>

                ${escapeHTML(item[0])}
            </span>

            <strong>${money(item[1])}</strong>
        </div>
    `).join("");

    container.innerHTML = `
        <div class="donut-layout">

            <div class="donut-chart"
                style="background:conic-gradient(${gradients.join(",")})">
            </div>

            <div class="donut-legend">
                <strong>Total: ${money(total)}</strong>
                ${legend}
            </div>

        </div>

        <small style="display:block;margin-top:12px;color:#64748b;">
            Settlement amounts are shown separately from actual spending.
        </small>
    `;
}


// Daily spending chart
function renderDailySpending(expenses, selectedMonth) {
    const container = document.getElementById("dailySpendingChart");

    if (!container) return;

    const [year, month] = selectedMonth.split("-").map(Number);

    const daysInMonth = new Date(year, month, 0).getDate();

    const dailyTotals = Array(daysInMonth).fill(0);

    expenses
        .filter(item => monthKey(item.date) === selectedMonth)
        .forEach(item => {
            const day = Number(item.date.slice(8, 10));

            if (day >= 1 && day <= daysInMonth) {
                dailyTotals[day - 1] += Number(item.amount || 0);
            }
        });

    const maximum = Math.max(...dailyTotals, 1);

    container.innerHTML = `
        <div class="daily-chart">
            ${dailyTotals.map((amount, index) => `
                <div class="daily-column"
                    title="Day ${index + 1}: ${money(amount)}">

                    <div class="daily-bar"
                        style="height:${Math.max(2, amount / maximum * 100)}%">
                    </div>

                    <span class="daily-day">${index + 1}</span>
                </div>
            `).join("")}
        </div>

        <p>
            Highest daily spending:
            <strong>${money(Math.max(...dailyTotals))}</strong>
        </p>
    `;
}


// Monthly savings trend
function renderSavingsTrend(incomes, expenses, selectedMonth) {
    const container = document.getElementById("savingsTrendChart");

    if (!container) return;

    const [year, month] = selectedMonth.split("-").map(Number);

    const months = [];

    for (let offset = 5; offset >= 0; offset--) {
        const date = new Date(year, month - 1 - offset, 1);

        const key =
            `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

        const income = totalForMonth(incomes, key);
        const expense = totalForMonth(expenses, key);

        months.push({
            label: date.toLocaleDateString("en-IN", {
                month: "short"
            }),
            savings: roundMoney(income - expense)
        });
    }

    const maximum = Math.max(
        ...months.map(item => Math.abs(item.savings)),
        1
    );

    container.innerHTML = `
        <div class="savings-chart">
            ${months.map(item => {
                const height = Math.max(
                    2,
                    Math.abs(item.savings) / maximum * 100
                );

                const positive = item.savings >= 0;

                return `
                    <div class="savings-column"
                        title="${item.label}: ${money(item.savings)}">

                        <div class="savings-bar
                            ${positive ? "savings-positive" : "savings-negative"}"
                            style="height:${height}%">
                        </div>

                        <span class="savings-month">
                            ${escapeHTML(item.label)}
                        </span>
                    </div>
                `;
            }).join("")}
        </div>

        <p>Green = savings · Red = overspending</p>
    `;
}


// Start the application
startApp();
