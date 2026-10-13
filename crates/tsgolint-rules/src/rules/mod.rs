//! The 60 rules, one module each, and the registry. A rule module exports
//! `pub static RULE: RuleDefinition`.

use tsgolint_core::RuleDefinition;

pub mod await_thenable;
pub mod consistent_return;
pub mod consistent_type_exports;
pub mod dot_notation;
pub mod no_array_delete;
pub mod no_base_to_string;
pub mod no_confusing_void_expression;
pub mod no_deprecated;
pub mod no_duplicate_type_constituents;
pub mod no_floating_promises;
pub mod no_for_in_array;
pub mod no_generated_empty_object_type;
pub mod no_implied_eval;
pub mod no_meaningless_void_operator;
pub mod no_misused_promises;
pub mod no_misused_spread;
pub mod no_mixed_enums;
pub mod no_redundant_type_constituents;
pub mod no_unnecessary_boolean_literal_compare;
pub mod no_unnecessary_condition;
pub mod no_unnecessary_qualifier;
pub mod no_unnecessary_template_expression;
pub mod no_unnecessary_type_arguments;
pub mod no_unnecessary_type_assertion;
pub mod no_unnecessary_type_conversion;
pub mod no_unnecessary_type_parameters;
pub mod no_unsafe_argument;
pub mod no_unsafe_assignment;
pub mod no_unsafe_call;
pub mod no_unsafe_enum_comparison;
pub mod no_unsafe_member_access;
pub mod no_unsafe_return;
pub mod no_unsafe_type_assertion;
pub mod no_unsafe_unary_minus;
pub mod no_useless_default_assignment;
pub mod non_nullable_type_assertion_style;
pub mod only_throw_error;
pub mod prefer_find;
pub mod prefer_includes;
pub mod prefer_nullish_coalescing;
pub mod prefer_optional_chain;
pub mod prefer_promise_reject_errors;
pub mod prefer_readonly;
pub mod prefer_readonly_parameter_types;
pub mod prefer_reduce_type_parameter;
pub mod prefer_regexp_exec;
pub mod prefer_return_this_type;
pub mod prefer_string_starts_ends_with;
pub mod promise_function_async;
pub mod related_getter_setter_pairs;
pub mod require_array_sort_compare;
pub mod require_await;
pub mod restrict_plus_operands;
pub mod restrict_template_expressions;
pub mod return_await;
pub mod strict_boolean_expressions;
pub mod strict_void_return;
pub mod switch_exhaustiveness_check;
pub mod unbound_method;
pub mod use_unknown_in_catch_callback_variable;

/// Every rule, in tsgolint's order (`cmd/tsgolint/main.go`).
pub static ALL_RULES: &[&RuleDefinition] = &[
    &await_thenable::RULE,
    &consistent_return::RULE,
    &consistent_type_exports::RULE,
    &dot_notation::RULE,
    &no_array_delete::RULE,
    &no_base_to_string::RULE,
    &no_confusing_void_expression::RULE,
    &no_deprecated::RULE,
    &no_duplicate_type_constituents::RULE,
    &no_floating_promises::RULE,
    &no_for_in_array::RULE,
    &no_generated_empty_object_type::RULE,
    &no_implied_eval::RULE,
    &no_meaningless_void_operator::RULE,
    &no_misused_promises::RULE,
    &no_misused_spread::RULE,
    &no_mixed_enums::RULE,
    &no_redundant_type_constituents::RULE,
    &no_unnecessary_boolean_literal_compare::RULE,
    &no_unnecessary_condition::RULE,
    &no_unnecessary_qualifier::RULE,
    &no_unnecessary_template_expression::RULE,
    &no_unnecessary_type_conversion::RULE,
    &no_unnecessary_type_arguments::RULE,
    &no_unnecessary_type_parameters::RULE,
    &no_unnecessary_type_assertion::RULE,
    &no_useless_default_assignment::RULE,
    &no_unsafe_argument::RULE,
    &no_unsafe_assignment::RULE,
    &no_unsafe_call::RULE,
    &no_unsafe_enum_comparison::RULE,
    &no_unsafe_member_access::RULE,
    &no_unsafe_return::RULE,
    &no_unsafe_type_assertion::RULE,
    &no_unsafe_unary_minus::RULE,
    &non_nullable_type_assertion_style::RULE,
    &only_throw_error::RULE,
    &prefer_find::RULE,
    &prefer_includes::RULE,
    &prefer_optional_chain::RULE,
    &prefer_nullish_coalescing::RULE,
    &prefer_promise_reject_errors::RULE,
    &prefer_readonly_parameter_types::RULE,
    &prefer_regexp_exec::RULE,
    &prefer_readonly::RULE,
    &prefer_reduce_type_parameter::RULE,
    &prefer_return_this_type::RULE,
    &prefer_string_starts_ends_with::RULE,
    &promise_function_async::RULE,
    &related_getter_setter_pairs::RULE,
    &require_array_sort_compare::RULE,
    &require_await::RULE,
    &restrict_plus_operands::RULE,
    &restrict_template_expressions::RULE,
    &return_await::RULE,
    &strict_boolean_expressions::RULE,
    &strict_void_return::RULE,
    &switch_exhaustiveness_check::RULE,
    &unbound_method::RULE,
    &use_unknown_in_catch_callback_variable::RULE,
];

/// The rule named `name`.
pub fn find_rule(name: &str) -> Option<&'static RuleDefinition> {
    ALL_RULES.iter().copied().find(|rule| rule.name == name)
}
