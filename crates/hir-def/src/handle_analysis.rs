use fxhash::{FxHashMap, FxHashSet};
use syntax::TSKind;

use crate::{
    body::Body,
    hir::{type_ref::TypeRef, Expr, ExprId},
    item_tree::Name,
    resolver::{Resolver, ValueNs},
    DefDatabase, InferenceResult, MethodmapId,
};

/// A detected handle leak: a local variable was assigned a handle value
/// but never closed or transferred within the function body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleLeak {
    /// The expression where the handle was allocated (the binding expression).
    pub alloc_expr: ExprId,
    /// The type name of the handle (e.g. "KeyValues", "File").
    pub type_name: Name,
}

/// Check whether a methodmap is a Handle subtype by walking the inheritance chain.
/// Returns `true` if the methodmap itself is named "Handle" or inherits from "Handle".
fn is_handle_subtype(db: &dyn DefDatabase, methodmap_id: MethodmapId) -> bool {
    let mut current = methodmap_id;
    for _ in 0..20 {
        let data = db.methodmap_data(current);
        if data.name == Name::from("Handle") {
            return true;
        }
        match data.inherits {
            Some(parent) => current = parent,
            None => return false,
        }
    }
    false
}

/// Given a type reference, resolve it to a MethodmapId and check if it's a Handle subtype.
/// Returns the type name if it is.
fn resolve_type_as_handle(
    db: &dyn DefDatabase,
    resolver: &Resolver,
    type_ref: &TypeRef,
) -> Option<Name> {
    let name = match type_ref {
        TypeRef::Name(name) => name,
        _ => return None,
    };
    let name_str: String = name.clone().into();
    let resolved = resolver.resolve_ident(&name_str)?;
    if let ValueNs::MethodmapId(it) = resolved {
        if is_handle_subtype(db, it.value) {
            return Some(name.clone());
        }
    }
    None
}

/// Analyze a function body for handle leaks.
///
/// Returns a list of `HandleLeak` for each local variable that is assigned a handle value
/// but never closed or transferred within the function body.
pub fn analyze_handles(
    db: &dyn DefDatabase,
    body: &Body,
    resolver: &Resolver,
    inference_result: &InferenceResult,
) -> Vec<HandleLeak> {
    // Map from binding ExprId -> (alloc ExprId, type name)
    let mut allocations: FxHashMap<ExprId, (ExprId, Name)> = FxHashMap::default();
    // Set of binding ExprIds that are "safe" (closed, returned, escaped)
    let mut safe: FxHashSet<ExprId> = FxHashSet::default();

    // Pass 1: Find all bindings that allocate handles
    for (expr_id, expr) in body.exprs.iter() {
        if let Expr::Binding {
            initializer: Some(init_expr),
            type_ref,
            ..
        } = expr
        {
            let handle_type = match &body[*init_expr] {
                Expr::New { name, .. } => {
                    let name_str: String = name.clone().into();
                    if let Some(ValueNs::MethodmapId(it)) = resolver.resolve_ident(&name_str) {
                        if is_handle_subtype(db, it.value) {
                            Some(name.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                Expr::Call { callee, .. } => {
                    // Try to resolve the callee's return type as a handle
                    let callee_expr = &body[*callee];
                    if let Expr::Ident(callee_name) = callee_expr {
                        let callee_str: String = callee_name.clone().into();
                        if let Some(ValueNs::FunctionId(fn_ids)) =
                            resolver.resolve_ident(&callee_str)
                        {
                            fn_ids.iter().find_map(|fn_id| {
                                let fn_data = db.function_data(fn_id.value);
                                fn_data
                                    .type_ref
                                    .as_ref()
                                    .and_then(|ty| resolve_type_as_handle(db, resolver, ty))
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                Expr::MethodCall {
                    method_name: _,
                    target: _,
                    ..
                } => {
                    // Use inference_result to find what method was resolved
                    if let Some(fn_id) = inference_result.method_resolution(*init_expr) {
                        let fn_data = db.function_data(fn_id);
                        fn_data
                            .type_ref
                            .as_ref()
                            .and_then(|ty| resolve_type_as_handle(db, resolver, ty))
                    } else {
                        None
                    }
                }
                _ => None,
            };

            // Also check the binding's declared type if no handle was found from the initializer
            let handle_type = handle_type.or_else(|| {
                // If the binding has a declared type that's a handle and the initializer
                // is a call/new, it might still be a handle allocation
                // But we already check the initializer above, so this is a fallback
                // for when the initializer type couldn't be resolved but the declared type is a handle
                if matches!(
                    &body[*init_expr],
                    Expr::Call { .. } | Expr::MethodCall { .. } | Expr::New { .. }
                ) {
                    type_ref
                        .as_ref()
                        .and_then(|ty| resolve_type_as_handle(db, resolver, ty))
                } else {
                    None
                }
            });

            if let Some(type_name) = handle_type {
                allocations.insert(expr_id, (*init_expr, type_name));
            }
        }
    }

    if allocations.is_empty() {
        return Vec::new();
    }

    // Build a reverse map: for each Expr::Ident, find which binding ExprId it refers to
    // so we can track when a handle variable is used.
    let binding_exprs: FxHashSet<ExprId> = allocations.keys().copied().collect();

    // Helper: given an ExprId that might be an Ident, find the binding it refers to
    let resolve_to_binding = |expr_id: &ExprId| -> Option<ExprId> {
        if let Expr::Ident(name) = &body[*expr_id] {
            let name_str: String = name.clone().into();
            if let Some(ValueNs::LocalId((_, _, binding_expr))) =
                resolver.resolve_ident(&name_str)
            {
                if binding_exprs.contains(&binding_expr) {
                    return Some(binding_expr);
                }
            }
        }
        None
    };

    // Pass 2: Find all closures/escapes
    for (expr_id, expr) in body.exprs.iter() {
        match expr {
            // `delete variable`
            Expr::Control {
                keyword,
                operand: Some(operand),
            } if *keyword == TSKind::anon_delete_ => {
                if let Some(binding) = resolve_to_binding(operand) {
                    safe.insert(binding);
                }
            }
            // `return variable`
            Expr::Control {
                keyword,
                operand: Some(operand),
            } if *keyword == TSKind::anon_return_ => {
                if let Some(binding) = resolve_to_binding(operand) {
                    safe.insert(binding);
                }
            }
            // `variable.Close()`
            Expr::MethodCall {
                target,
                method_name,
                ..
            } if method_name == &Name::from("Close") => {
                if let Some(binding) = resolve_to_binding(target) {
                    safe.insert(binding);
                }
            }
            // `CloseHandle(variable)` or any function call with handle as argument
            Expr::Call { callee, args } => {
                // Any argument passed to a function is considered an escape
                for arg in args.iter() {
                    // Unwrap NamedArg
                    let actual_arg = if let Expr::NamedArg { value, .. } = &body[*arg] {
                        value
                    } else {
                        arg
                    };
                    if let Some(binding) = resolve_to_binding(actual_arg) {
                        safe.insert(binding);
                    }
                }
                // Also check if callee is "CloseHandle" specifically
                // (already covered by args above, but also mark it for the first arg)
                let _ = callee; // Handled by args iteration
            }
            // Method call args are also escapes
            Expr::MethodCall { args, .. } => {
                for arg in args.iter() {
                    let actual_arg = if let Expr::NamedArg { value, .. } = &body[*arg] {
                        value
                    } else {
                        arg
                    };
                    if let Some(binding) = resolve_to_binding(actual_arg) {
                        safe.insert(binding);
                    }
                }
            }
            // Assignment to a field, global, or array element: `obj.field = handle`
            Expr::BinaryOp { lhs, rhs, op } => {
                if matches!(op, Some(TSKind::anon_EQ))
                    && matches!(
                        &body[*lhs],
                        Expr::FieldAccess { .. }
                            | Expr::ArrayIndexedAccess { .. }
                            | Expr::ScopeAccess { .. }
                    )
                {
                    if let Some(binding) = resolve_to_binding(rhs) {
                        safe.insert(binding);
                    }
                }
            }
            // Also mark as safe if the variable is used in a `new` constructor arg
            Expr::New { args, .. } => {
                for arg in args.iter() {
                    if let Some(binding) = resolve_to_binding(arg) {
                        safe.insert(binding);
                    }
                }
            }
            _ => {}
        }

        // Also check: if this expr_id is a binding that's being reassigned,
        // ignore it (already tracked in allocations).
        let _ = expr_id;
    }

    // Pass 3: Report leaks
    allocations
        .into_iter()
        .filter(|(binding_expr, _)| !safe.contains(binding_expr))
        .map(|(_, (alloc_expr, type_name))| HandleLeak {
            alloc_expr,
            type_name,
        })
        .collect()
}
