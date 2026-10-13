//! `prefer-readonly-parameter-types`: requires function parameters to have
//! readonly types.

use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{CheckFlags, ModifierFlags, SymbolFlags, TypeFlags};
use goport_core::frontend::vfs::Fs;
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, get_call_signatures, get_construct_signatures, is_intersection_type,
    is_object_type, is_union_type, type_matches_some_specifier,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-readonly-parameter-types",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
    check_parameter_properties: bool,
    ignore_inferred_types: bool,
    treat_methods_as_readonly: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            allow: Vec::new(),
            check_parameter_properties: true,
            ignore_inferred_types: false,
            treat_methods_as_readonly: false,
        }
    }
}

fn should_be_readonly_message() -> RuleMessage {
    RuleMessage::new("shouldBeReadonly", "Parameter should be a readonly type.")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut listeners = Listeners::new(options);
    for kind in [
        SyntaxKind::ArrowFunction,
        SyntaxKind::CallSignature,
        SyntaxKind::ConstructSignature,
        SyntaxKind::Constructor,
        SyntaxKind::FunctionDeclaration,
        SyntaxKind::FunctionExpression,
        SyntaxKind::FunctionType,
        SyntaxKind::MethodDeclaration,
        SyntaxKind::MethodSignature,
    ] {
        listeners = listeners.on(kind, check_parameters);
    }
    listeners.into()
}

fn check_parameters(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    for parameter in node.parameters() {
        let is_property = is_parameter_property(parameter);
        if is_property && !options.check_parameter_properties {
            continue;
        }
        let type_node = parameter.type_();
        if options.ignore_inferred_types && type_node.is_nil() {
            continue;
        }
        let t = if type_node.is_some() {
            ctx.checker.get_type_from_type_node(type_node)
        } else {
            ctx.checker.get_type_at_location(parameter)
        };
        if t.is_nil() {
            continue;
        }

        let fs = ctx.fs();
        let mut walker = ReadonlyWalker {
            c: ctx.checker,
            fs: &*fs,
            options,
            seen: FxHashSet::default(),
        };
        if walker.check(t) == Readonlyness::Readonly || is_type_branded_literal_like(ctx.checker, t)
        {
            continue;
        }

        let name = parameter.name();
        if is_property && name.is_some() {
            // A parameter property is reported from its name, after the modifiers.
            let name_start = ctx.trim_node_text_range(name).pos();
            ctx.report_range(
                parameter.loc().with_pos(name_start),
                should_be_readonly_message(),
            );
        } else {
            ctx.report_node(parameter, should_be_readonly_message());
        }
    }
}

fn is_parameter_property(parameter: Node) -> bool {
    parameter.kind() == SyntaxKind::Parameter
        && parameter.parent().is_some()
        && parameter.parent().kind() == SyntaxKind::Constructor
        && parameter
            .modifier_flags()
            .intersects(ModifierFlags::PARAMETER_PROPERTY_MODIFIER)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Readonlyness {
    Unknown,
    Mutable,
    Readonly,
}

/// typescript-eslint `isTypeReadonly`, with the set of types already seen.
struct ReadonlyWalker<'a> {
    c: &'a mut Checker,
    fs: &'a dyn Fs,
    options: &'a Options,
    seen: FxHashSet<TypeId>,
}

impl ReadonlyWalker<'_> {
    fn check(&mut self, t: TypeId) -> Readonlyness {
        self.seen.insert(t);

        if type_matches_some_specifier(self.c, self.fs, t, &self.options.allow) {
            return Readonlyness::Readonly;
        }

        if is_union_type(self.c, t) {
            let parts = self.c.ty(t).types_list();
            return self.all_unseen_readonly(&parts);
        }

        if is_intersection_type(self.c, t) {
            let parts = self.c.ty(t).types_list();
            let has_array_or_tuple = parts
                .iter()
                .any(|&part| self.c.is_array_type(part) || self.c.is_tuple_type(part));
            if has_array_or_tuple {
                return self.all_unseen_readonly(&parts);
            }
            return self.check_object(t);
        }

        if !is_object_type(self.c, t) {
            return Readonlyness::Readonly;
        }

        // A function without properties.
        if !get_call_signatures(self.c, t).is_empty() && self.c.get_properties_of_type(t).is_empty()
        {
            return Readonlyness::Readonly;
        }

        let array = self.check_array_or_tuple(t);
        if array != Readonlyness::Unknown {
            return array;
        }
        self.check_object(t)
    }

    fn all_unseen_readonly(&mut self, parts: &[TypeId]) -> Readonlyness {
        for &part in parts {
            if !self.seen.contains(&part) && self.check(part) != Readonlyness::Readonly {
                return Readonlyness::Mutable;
            }
        }
        Readonlyness::Readonly
    }

    fn check_array_or_tuple(&mut self, t: TypeId) -> Readonlyness {
        if self.c.is_array_type(t) {
            let symbol = self.c.ty(t).symbol;
            if symbol.is_some() && self.c.sym(symbol).name.as_str() == "Array" {
                return Readonlyness::Mutable;
            }
            return self.check_type_arguments(t);
        }

        if self.c.is_tuple_type(t) {
            let mut target = self.c.ty(t).target();
            if target.is_nil() {
                target = t;
            }
            if !self.c.is_tuple_type(target) {
                return Readonlyness::Unknown;
            }
            if !self.c.ty(target).as_tuple_type().readonly {
                return Readonlyness::Mutable;
            }
            return self.check_type_arguments(t);
        }

        Readonlyness::Unknown
    }

    fn check_type_arguments(&mut self, t: TypeId) -> Readonlyness {
        for argument in self.c.get_type_arguments(t) {
            if self.check(argument) == Readonlyness::Mutable {
                return Readonlyness::Mutable;
            }
        }
        Readonlyness::Readonly
    }

    /// Mutable or Readonly, never Unknown.
    fn check_object(&mut self, t: TypeId) -> Readonlyness {
        let properties = self.c.get_properties_of_type(t);

        for &property in properties.iter() {
            let flags = self.c.sym(property).flags;
            if self.options.treat_methods_as_readonly && flags.intersects(SymbolFlags::METHOD) {
                continue;
            }
            if property_is_readonly(self.c, property)
                || property_has_private_identifier_name(self.c, property)
                // `Readonly<T>` and other mapped types do not expose `private`
                // class properties, so their own mutability does not matter.
                || property_is_private_mapped(self.c, property)
            {
                continue;
            }
            return Readonlyness::Mutable;
        }

        for &property in properties.iter() {
            if self.c.sym(property).flags.intersects(SymbolFlags::METHOD)
                || property_has_private_identifier_name(self.c, property)
                || property_is_private_mapped(self.c, property)
            {
                continue;
            }
            let name = self.c.sym(property).name.clone();
            let mut property_type = self.c.get_type_of_property_of_type(t, &name);
            if property_type.is_nil() {
                property_type = self.c.get_type_of_symbol(property);
            }
            if property_type.is_nil() || self.seen.contains(&property_type) {
                continue;
            }
            if self.check(property_type) == Readonlyness::Mutable {
                return Readonlyness::Mutable;
            }
        }

        for info in self.c.get_index_infos_of_type(t) {
            let info = self.c.index_info(info);
            if !info.is_readonly() {
                return Readonlyness::Mutable;
            }
            let value_type = info.value_type();
            if value_type.is_nil() || value_type == t || self.seen.contains(&value_type) {
                continue;
            }
            if self.check(value_type) == Readonlyness::Mutable {
                return Readonlyness::Mutable;
            }
        }

        Readonlyness::Readonly
    }
}

fn property_has_private_identifier_name(c: &Checker, property: SymbolId) -> bool {
    let is_private_name = |declaration: Node| {
        let name = declaration.name();
        name.is_some() && name.kind() == SyntaxKind::PrivateIdentifier
    };
    let symbol = c.sym(property);
    if symbol.value_declaration.is_some() {
        return is_private_name(symbol.value_declaration);
    }
    symbol
        .declarations
        .iter()
        .any(|&declaration| declaration.is_some() && is_private_name(declaration))
}

fn property_is_private_mapped(c: &Checker, property: SymbolId) -> bool {
    c.sym(property).check_flags.intersects(CheckFlags::MAPPED)
        && c.get_declaration_modifier_flags_from_symbol(property)
            .intersects(ModifierFlags::PRIVATE)
}

fn property_is_readonly(c: &mut Checker, property: SymbolId) -> bool {
    if c.is_readonly_symbol(property) {
        return true;
    }
    let symbol = c.sym(property);
    let check_flags = symbol.check_flags;
    let mapped = check_flags.intersects(CheckFlags::MAPPED);
    check_flags.intersects(CheckFlags::READONLY | CheckFlags::SYNTHETIC_METHOD)
        || (mapped && symbol.flags.intersects(SymbolFlags::METHOD))
        || (mapped && symbol.value_declaration.is_nil())
        || c.get_declaration_modifier_flags_from_symbol(property)
            .intersects(ModifierFlags::READONLY)
}

fn is_literal_or_taggable_primitive_like(c: &Checker, t: TypeId) -> bool {
    c.ty(t).flags.intersects(
        TypeFlags::LITERAL
            | TypeFlags::BIG_INT
            | TypeFlags::NUMBER
            | TypeFlags::STRING
            | TypeFlags::TEMPLATE_LITERAL,
    )
}

fn is_object_literal_like(c: &mut Checker, t: TypeId) -> bool {
    get_call_signatures(c, t).is_empty()
        && get_construct_signatures(c, t).is_empty()
        && is_object_type(c, t)
}

/// An intersection of object types and primitives, such as
/// `string & { __brand: 'x' }`.
fn is_type_branded_literal(c: &mut Checker, t: TypeId) -> bool {
    if !is_intersection_type(c, t) {
        return false;
    }
    let mut had_object_like = false;
    let mut had_primitive_like = false;
    for part in c.ty(t).types_list() {
        if is_object_literal_like(c, part) {
            had_object_like = true;
        } else if is_literal_or_taggable_primitive_like(c, part) {
            had_primitive_like = true;
        } else {
            return false;
        }
    }
    had_object_like && had_primitive_like
}

fn is_type_branded_literal_like(c: &mut Checker, t: TypeId) -> bool {
    if is_union_type(c, t) {
        return c
            .ty(t)
            .types_list()
            .into_iter()
            .all(|part| is_type_branded_literal(c, part));
    }
    is_type_branded_literal(c, t)
}
