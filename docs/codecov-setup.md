# CodeCov Integration Setup

## Overview

This project uses [CodeCov](https://about.codecov.io/) to track code coverage and enforce coverage gates in CI/CD pipelines.

## Coverage Requirements

- **Minimum Project Coverage**: 80%
- **Minimum Patch Coverage**: 80%
- **Threshold**: 1% (allows minor fluctuations)

## Configuration

The CodeCov configuration is defined in `codecov.yml` at the root of the repository.

### Key Settings

- **Project Coverage Gate**: Fails if overall project coverage drops below 80%
- **Patch Coverage Gate**: Fails if new code in a PR has less than 80% coverage
- **Coverage Reports**: Generated for:
  - Explorer contract (Rust)
  - Ticket contract (Rust)
  - Indexer (Node.js/TypeScript)

### Ignored Files

The following file types are excluded from coverage calculations:
- Documentation files (`*.md`)
- Configuration files (`*.yml`, `*.yaml`, `*.json`, `*.toml`)
- Test snapshots
- Fuzz targets
- Test files
- GitHub workflows
- Documentation directory

## CI/CD Integration

### Workflows with CodeCov

1. **CI Workflow** (`.github/workflows/ci.yml`)
   - Runs tests with coverage for explorer contract
   - Runs indexer tests with coverage
   - Uploads both coverage reports to CodeCov

2. **Contract Tests Workflow** (`.github/workflows/contract-tests.yml`)
   - Runs comprehensive test suite for ticket contract
   - Enforces 85% local coverage threshold
   - Uploads coverage to CodeCov

### Required Secret

Add the following secret to your GitHub repository:

- `CODECOV_TOKEN`: Your CodeCov upload token
  - Get this from: https://app.codecov.io/gh/YOUR_ORG/YOUR_REPO/settings
  - Add it to: Repository Settings → Secrets and variables → Actions → New repository secret

## Local Coverage Testing

### Rust Contracts

```bash
# Install cargo-llvm-cov
cargo install cargo-llvm-cov

# Explorer contract
cargo llvm-cov --workspace --lcov --output-path lcov.info
cargo llvm-cov report

# Ticket contract
cd contracts/ticket
cargo llvm-cov --features testutils --release --lcov --output-path lcov.info
cargo llvm-cov report --features testutils --release
```

### Indexer (Node.js)

```bash
cd indexer
npm test -- --coverage
```

## How It Works

1. **On Push/PR**: CI workflows run tests with coverage collection enabled
2. **Coverage Upload**: Coverage reports (lcov format) are uploaded to CodeCov
3. **Analysis**: CodeCov analyzes the coverage data and compares against thresholds
4. **Status Check**: If coverage is below 80%, the CI check fails and blocks the PR
5. **Comments**: CodeCov adds a comment to PRs showing coverage changes

## Viewing Coverage Reports

- **Online Dashboard**: https://app.codecov.io/gh/YOUR_ORG/YOUR_REPO
- **PR Comments**: CodeCov automatically comments on PRs with coverage details
- **Badge**: Add to README:
  ```markdown
  [![codecov](https://codecov.io/gh/YOUR_ORG/YOUR_REPO/branch/main/graph/badge.svg)](https://codecov.io/gh/YOUR_ORG/YOUR_REPO)
  ```

## Troubleshooting

### Coverage Upload Fails

- Verify `CODECOV_TOKEN` is set correctly in GitHub secrets
- Check the CodeCov action logs for specific error messages
- Ensure the lcov.info file is being generated correctly

### Coverage Below Threshold

- Run tests locally with coverage to identify untested code
- Add tests to cover the missing code paths
- Consider adjusting thresholds in `codecov.yml` if necessary (with team approval)

### False Positives

- Update the `ignore` section in `codecov.yml` to exclude generated or non-critical files

## References

- [CodeCov Documentation](https://docs.codecov.com/)
- [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)
- [Jest Coverage](https://jestjs.io/docs/configuration#collectcoverage-boolean)
