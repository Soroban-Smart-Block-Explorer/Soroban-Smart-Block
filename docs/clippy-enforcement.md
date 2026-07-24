# Clippy Enforcement in CI

## Overview

This project enforces Rust clippy linting in CI with warnings treated as errors. Any clippy warnings will cause the build to fail, ensuring code quality and preventing common bugs.

## Implementation

### CI Workflow (`.github/workflows/ci.yml`)

The main CI workflow runs clippy on all workspace members with the following command:

```bash
cargo clippy --all-targets --all-features -- -D warnings
```

**Flags Explained:**
- `--all-targets`: Lint all targets (lib, bins, tests, examples, benches)
- `--all-features`: Enable all feature flags during linting
- `-- -D warnings`: Deny all warnings (treat them as errors)

This runs on:
- Explorer contract (workspace member)
- Ticket contract (independent crate, tested separately)

## Local Development

### Running Clippy Locally

To run clippy with the same settings as CI:

```bash
# From repository root (explorer contract)
cargo clippy --all-targets --all-features -- -D warnings

# Ticket contract
cd contracts/ticket
cargo clippy --all-targets --features testutils -- -D warnings
```

### Before Committing

Always run clippy locally before pushing to catch issues early:

```bash
# Quick check
cargo clippy --all-targets --all-features -- -D warnings

# Auto-fix issues where possible
cargo clippy --fix --all-targets --all-features -- -D warnings
```

### IDE Integration

Configure your IDE to run clippy on save for immediate feedback:

#### VS Code (rust-analyzer)
Add to `.vscode/settings.json`:
```json
{
  "rust-analyzer.checkOnSave.command": "clippy",
  "rust-analyzer.checkOnSave.extraArgs": ["--all-targets", "--all-features", "--", "-D", "warnings"]
}
```

#### IntelliJ IDEA / CLion
1. Go to Settings → Languages & Frameworks → Rust → External Linters
2. Enable "Run external linter to analyze code on the fly"
3. Set "External tool" to "Clippy"
4. Add arguments: `--all-targets --all-features -- -D warnings`

#### Vim/Neovim (with ALE)
Add to your config:
```vim
let g:ale_rust_cargo_use_clippy = 1
let g:ale_rust_clippy_options = '--all-targets --all-features -- -D warnings'
```

## Common Clippy Warnings

### 1. Unnecessary Clones
```rust
// ❌ Warning
let s = my_string.clone();
do_something(&s);

// ✅ Fixed
do_something(&my_string);
```

### 2. Useless Conversion
```rust
// ❌ Warning
let x: u32 = value.into();

// ✅ Fixed (if value is already u32)
let x: u32 = value;
```

### 3. Needless Return
```rust
// ❌ Warning
fn add(a: i32, b: i32) -> i32 {
    return a + b;
}

// ✅ Fixed
fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

### 4. Redundant Field Names
```rust
// ❌ Warning
Person { name: name, age: age }

// ✅ Fixed
Person { name, age }
```

### 5. Single Match
```rust
// ❌ Warning
match x {
    Some(val) => println!("{}", val),
    _ => {}
}

// ✅ Fixed
if let Some(val) = x {
    println!("{}", val);
}
```

## Handling Clippy in CI

### If CI Fails on Clippy

1. **Check the CI logs** to see which warnings were triggered
2. **Run locally** to reproduce: `cargo clippy --all-targets --all-features -- -D warnings`
3. **Fix the issues** or apply suggested fixes with `--fix`
4. **Commit and push** the fixes

### Auto-fixing

Many clippy warnings can be automatically fixed:

```bash
cargo clippy --fix --all-targets --all-features -- -D warnings
```

**Note**: Review the changes before committing, as auto-fixes may occasionally need manual adjustment.

## Allowing Specific Warnings

In rare cases, you may need to allow a specific warning. Use `#[allow(clippy::lint_name)]`:

```rust
#[allow(clippy::too_many_arguments)]
fn complex_function(a: i32, b: i32, c: i32, d: i32, e: i32, f: i32, g: i32) {
    // ...
}
```

**Important**: Only allow lints when:
1. The warning is a false positive
2. The suggested fix would make code less readable
3. You've discussed with the team and documented why

Always add a comment explaining why the lint is allowed:

```rust
// Clippy suggests using `if let`, but match is clearer here due to complex patterns
#[allow(clippy::single_match)]
match complex_enum {
    Variant::Complex(a, b, c) if a > 0 && b < 10 => process(a, b, c),
    _ => {}
}
```

## Configuration

Clippy behavior can be customized via `clippy.toml` in the repository root. Currently, we use default settings to maintain consistency with Rust community standards.

### Adding Custom Rules

To customize clippy (use sparingly):

1. Create `clippy.toml` in repository root
2. Add configuration:
   ```toml
   # Example: Allow TODO comments
   allow-todo-in-tests = true
   ```
3. Document the rationale in this file

## Benefits

✅ **Prevents Code Quality Degradation**: Warnings caught before merge  
✅ **Consistency**: Same standards enforced for all contributors  
✅ **Early Detection**: Issues found in CI rather than code review  
✅ **Automated**: No manual checking required  
✅ **Comprehensive**: Lints all targets including tests and examples  

## Troubleshooting

### "Clippy is not installed"

Install clippy component:
```bash
rustup component add clippy
```

### "Clippy passes locally but fails in CI"

CI may use a newer Rust version with additional lints:
```bash
# Update to latest stable
rustup update stable

# Run clippy again
cargo clippy --all-targets --all-features -- -D warnings
```

### "Too many warnings to fix at once"

Fix incrementally:
1. Run clippy to see all warnings
2. Fix one category at a time (e.g., all "needless_return" warnings)
3. Commit after each category
4. Repeat until clean

### "Clippy suggests conflicting fixes"

Some suggestions may conflict. Review carefully and:
1. Apply the fix that improves readability most
2. If both are equivalent, choose the more idiomatic Rust style
3. If unclear, ask in code review

## References

- [Clippy Documentation](https://doc.rust-lang.org/clippy/)
- [Clippy Lint List](https://rust-lang.github.io/rust-clippy/master/)
- [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)

## Related Issues

- Closes #350: Enforce clippy warnings as errors in CI
