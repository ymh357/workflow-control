# Registry Packages

## Application Overview

The Registry page (`/registry`) displays available, installed, and local packages in the workflow-control ecosystem. Users can search, filter by type, install/uninstall packages, expand details, and publish local packages. The page fetches data from the server API at `/api/registry/*`.

## Test Scenarios

### Scenario 1: Page loads and displays packages

1. Navigate to `/registry`
2. Verify the page title and subtitle are visible
3. Verify the stats bar shows "Available", "Installed" counts
4. Verify at least one package card is rendered in the list

**Expected:** Page renders with header, stats, and package list.

### Scenario 2: Filter packages by type

1. Navigate to `/registry`
2. Click the "Skill" filter button
3. Verify all visible package cards have the "skill" type badge
4. Click the "All" filter button
5. Verify packages of mixed types are shown again

**Expected:** Filter buttons narrow the displayed list to the selected type.

### Scenario 3: Search packages by name

1. Navigate to `/registry`
2. Type a known package name fragment into the search input
3. Verify the list narrows to show only matching packages
4. Clear the search input
5. Verify the full list is restored

**Expected:** Search input filters packages by name/description/tags in real time.

### Scenario 4: Install a package

1. Navigate to `/registry`
2. Find an uninstalled package
3. Click its "Install" button
4. Verify a success toast appears
5. Verify the button changes to "Installed"

**Expected:** Package installs successfully and UI updates to reflect installed state.

### Scenario 5: Uninstall a package

1. Navigate to `/registry`
2. Find an installed package
3. Click its "Installed" button (uninstall)
4. Verify a success toast appears
5. Verify the button changes back to "Install"

**Expected:** Package uninstalls and UI reverts to uninstalled state.

### Scenario 6: Expand package details

1. Navigate to `/registry`
2. Click on a package card row
3. Verify the expanded details section appears with author, files info
4. Click the same card row again
5. Verify the details section collapses

**Expected:** Clicking a package toggles its expanded detail view.
