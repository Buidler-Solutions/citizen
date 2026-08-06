//! Proc macros for the Civitas SDK.
//!
//! The main macro is `#[contract]`, applied to a module containing
//! public functions. Each `pub fn` becomes a dispatchable operation
//! identified by its function name.

use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, ItemMod, Item, Visibility};

/// Mark a module as a Civitas smart contract.
///
/// Every `pub fn` in the module becomes a dispatchable operation.
/// The function name is used as the operation name.
///
/// ```ignore
/// #[citizen_contract_derive::contract]
/// mod contract {
///     use super::*;
///
///     pub fn configure(ctx: Context) -> Result<Response> { ... }
///
///     pub fn assign_admin(ctx: Context) -> Result<Response> { ... }
///
///     pub fn check_admin(ctx: Context) -> Result<Response> { ... }
/// }
/// ```
#[proc_macro_attribute]
pub fn contract(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let module = parse_macro_input!(item as ItemMod);

    let mod_ident = &module.ident;

    let mut func_names: Vec<String> = Vec::new();

    if let Some((_, items)) = &module.content {
        for item in items.iter() {
            if let Item::Fn(fn_item) = item {
                if matches!(fn_item.vis, Visibility::Public(_)) {
                    func_names.push(fn_item.sig.ident.to_string());
                }
            }
        }
    }

    let match_arms = func_names.iter().map(|name| {
        let ident = syn::Ident::new(name, proc_macro2::Span::call_site());
        quote! {
            #name => #mod_ident::#ident(ctx),
        }
    });

    let expanded = quote! {
        #module

        /// WASM memory allocator export.
        #[no_mangle]
        pub extern "C" fn alloc(size: u32) -> u32 {
            citizen_contract_sdk::sdk_alloc(size)
        }

        /// WASM entry point — JSON dispatch to contract operations.
        #[no_mangle]
        pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
            let (ctx, op) = match citizen_contract_sdk::Context::parse(params_ptr, params_len) {
                Some(v) => v,
                None => {
                    return citizen_contract_sdk::write_result(
                        b"{\"ok\":false,\"error\":\"invalid json params\"}"
                    );
                }
            };

            let result: citizen_contract_sdk::Result = match op.as_str() {
                #(#match_arms)*
                _ => Err(citizen_contract_sdk::ContractError::Other(
                    alloc::format!("unknown operation: {op}")
                )),
            };

            match result {
                Ok(resp) => citizen_contract_sdk::write_result(resp.as_bytes()),
                Err(e) => citizen_contract_sdk::write_result(
                    citizen_contract_sdk::error_json(&e).as_bytes()
                ),
            }
        }

        #[panic_handler]
        fn _citizen_panic(_info: &core::panic::PanicInfo) -> ! {
            loop {}
        }
    };

    expanded.into()
}
