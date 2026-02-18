use crate::{Diagnostic, DiagnosticCode, DiagnosticsContext};

pub(crate) use self::handle_leak as f;

// Diagnostic: handle-leak
//
// This diagnostic is triggered when a local variable is assigned a handle value
// (from `new`, a function call, or a method call returning a Handle subtype)
// but is never closed via `delete`, `.Close()`, `CloseHandle()`, passed to
// another function, or returned.
pub(crate) fn handle_leak(ctx: &DiagnosticsContext<'_>, d: &hir::HandleLeak) -> Diagnostic {
    Diagnostic::new_with_syntax_node_ptr(
        ctx,
        DiagnosticCode::SpCompWarning("handle-leak"),
        format!(
            "handle of type `{}` is never closed (potential memory leak)",
            d.type_name
        ),
        d.expr,
    )
}
