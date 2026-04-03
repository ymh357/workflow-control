# Task Page — Draft & Config

## Application Overview

The Task page (`/task/[id]`) displays task execution details including status, stage timeline, message stream, and configuration. The root page (`/`) lists all tasks. This spec covers task listing, draft state display, and the Agent Config tab for MCP availability — excluding features that require real AI execution.

## Test Scenarios

### Scenario 1: Task list page loads

1. Navigate to `/`
2. Verify the task list is displayed
3. Verify each task entry shows its ID, status, and pipeline name

**Expected:** Home page renders a list of existing tasks.

### Scenario 2: Draft task displays correct status

1. Create or find a task in "draft" status
2. Navigate to its task page `/task/[id]`
3. Verify the status indicator shows "draft"
4. Verify the stage timeline is visible but not yet started

**Expected:** Draft tasks show pending status with unprogressed timeline.

### Scenario 3: Agent Config tab shows MCP availability

1. Navigate to a task page `/task/[id]`
2. Click the "Config" or "Agent Config" tab
3. Verify the pipeline configuration is displayed
4. Verify MCP entries are listed with their availability status

**Expected:** Config tab shows which MCPs are bound to each stage.

### Scenario 4: Delete a task

1. Navigate to `/`
2. Find a task in the list
3. Click the delete button for that task
4. Confirm deletion
5. Verify the task is removed from the list

**Expected:** Task is deleted and disappears from the task list.

### Scenario 5: Task detail navigation

1. Navigate to `/`
2. Click on a task entry
3. Verify navigation to `/task/[id]`
4. Verify task detail page renders with timeline and message stream areas

**Expected:** Clicking a task navigates to its detail page with proper layout.
