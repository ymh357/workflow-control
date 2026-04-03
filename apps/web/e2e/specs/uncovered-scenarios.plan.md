# Uncovered Scenarios Test Plan

## Application Overview

Supplementary test plan covering UI interactions not covered by existing hand-written tests. Discovered via Playwright Test Agent browser exploration.

## Test Scenarios

### 1. Home Page — Locale and Load More

**Seed:** `e2e/tests/mcp-seed.spec.ts`

#### 1.1. Language switcher toggles between EN and Chinese

**File:** `e2e/tests/home-locale.spec.ts`

**Steps:**
  1. Navigate to /
    - expect: EN and 中 buttons visible in nav bar
  2. Click 中 button
    - expect: Page switches to Chinese locale
  3. Click EN button
    - expect: Page switches back to English

#### 1.2. Show more button loads additional tasks

**File:** `e2e/tests/home-locale.spec.ts`

**Steps:**
  1. Navigate to /
    - expect: Task list loads
  2. Click Show N more button
    - expect: More tasks appear

#### 1.3. Notion URL input and Analyze button

**File:** `e2e/tests/home-locale.spec.ts`

**Steps:**
  1. Navigate to /
    - expect: Notion URL input and Analyze button visible
  2. Type URL into input
    - expect: Input shows URL
  3. Click Analyze
    - expect: Action triggered

### 2. Task Detail — AwaitingConfirm UI

**Seed:** `e2e/tests/mcp-seed.spec.ts`

#### 2.1. Confirm panel shows Confirm and Re-run buttons

**File:** `e2e/tests/task-confirm-panel.spec.ts`

**Steps:**
  1. Navigate to task in awaitingConfirm state
    - expect: Awaiting Confirm heading, Confirm and Re-run buttons visible
  2. Verify feedback textarea
    - expect: Textarea visible
  3. Verify Override repo name
    - expect: Collapsible group visible

#### 2.2. Confirm panel shows analysis data

**File:** `e2e/tests/task-confirm-panel.spec.ts`

**Steps:**
  1. Navigate to awaitingConfirm task
    - expect: Analysis heading with title, description, repoName fields

### 3. Task Detail — Log Filtering

**Seed:** `e2e/tests/mcp-seed.spec.ts`

#### 3.1. Log filter buttons toggle categories

**File:** `e2e/tests/task-log-filters.spec.ts`

**Steps:**
  1. Navigate to task detail
    - expect: Log entries visible
  2. Click Agent filter
    - expect: Filtered to agent messages
  3. Click All filter
    - expect: All messages shown

#### 3.2. Log search filters by text

**File:** `e2e/tests/task-log-filters.spec.ts`

**Steps:**
  1. Navigate to task detail
    - expect: Log entries visible
  2. Type search term
    - expect: Matching entries shown
  3. Clear search
    - expect: All entries restored

#### 3.3. Stage dropdown filters by stage

**File:** `e2e/tests/task-log-filters.spec.ts`

**Steps:**
  1. Navigate to task detail
    - expect: Stage dropdown has options
  2. Select specific stage
    - expect: Filtered to that stage
  3. Select All stages
    - expect: All messages shown

#### 3.4. Timeline stages are clickable

**File:** `e2e/tests/task-log-filters.spec.ts`

**Steps:**
  1. Navigate to task detail
    - expect: Timeline with stages visible
  2. Click a stage
    - expect: Stage highlighted

#### 3.5. Collapsible log entries expand

**File:** `e2e/tests/task-log-filters.spec.ts`

**Steps:**
  1. Navigate to task detail
    - expect: Collapsible entry visible
  2. Click entry
    - expect: Content expands

### 4. Registry — Publish

**Seed:** `e2e/tests/mcp-seed.spec.ts`

#### 4.1. Publish button visible for installed packages

**File:** `e2e/tests/registry-publish.spec.ts`

**Steps:**
  1. Navigate to /registry
    - expect: Packages load
  2. Find installed package
    - expect: Publish button visible
