/* eslint-disable @typescript-eslint/no-unused-vars */
import * as ts from 'typescript';
import { WinstonLogger, createGlobalLogger } from "../telemetry/logs";
import { DecoratorInfo, MethodInfo, TypeParser, ClassInfo, ParameterInfo } from './TypeParser';
import { APITypes, ArgSources } from '../httpServer/handler';
import { createParser, createFormatter, SchemaGenerator, SubNodeParser, BaseType, Context, ReferenceType, Schema, PrimitiveType, SubTypeFormatter, Definition, Config, TypeFormatter, DefinitionType, uniqueArray } from 'ts-json-schema-generator';
import { OpenAPIV3 as OpenApi3 } from 'openapi-types';

function isValid<T>(value: T | undefined): value is T { return value !== undefined; }

interface HttpEndpointInfo { verb: APITypes; path: string; }

function getOperonDecorator(decorated: MethodInfo | ParameterInfo | ClassInfo, name: string): DecoratorInfo | undefined {
  const filtered = decorated.decorators.filter(d => d.module === '@dbos-inc/operon' && d.name === name);
  if (filtered.length === 0) return undefined;
  if (filtered.length > 1) throw new Error(`Multiple ${JSON.stringify(name)} decorators found on ${decorated.name ?? "<unknown>"}`);
  return filtered[0];
}

function getHttpInfo(method: MethodInfo): HttpEndpointInfo | undefined {
  const getApiDecorator = getOperonDecorator(method, 'GetApi');
  const postApiDecorator = getOperonDecorator(method, 'PostApi');
  if (getApiDecorator && postApiDecorator) throw new Error(`Method ${method.name} has both GetApi and PostApi decorators`);
  if (!getApiDecorator && !postApiDecorator) return undefined;

  const verb = getApiDecorator ? APITypes.GET : APITypes.POST;
  const arg = getApiDecorator ? getApiDecorator.args[0] : postApiDecorator?.args[0];
  if (!arg) throw new Error(`Missing path argument for ${verb}Api decorator`);
  if (!ts.isStringLiteral(arg)) throw new Error(`Unexpected path argument type: ${ts.SyntaxKind[arg.kind]}`);
  return { verb, path: arg.text };
}

function getParamSource(parameter: ParameterInfo, verb: APITypes): ArgSources.BODY | ArgSources.QUERY | ArgSources.URL {
  const argSource = getOperonDecorator(parameter, 'ArgSource');
  if (!argSource) return getDefaultArgSource(verb);

  if (!ts.isPropertyAccessExpression(argSource.args[0])) throw new Error(`Unexpected ArgSource argument type: ${ts.SyntaxKind[argSource.args[0].kind]}`);
  switch (argSource.args[0].name.text) {
    case "BODY": return ArgSources.BODY;
    case "QUERY": return ArgSources.QUERY;
    case "URL": return ArgSources.URL;
    case "DEFAULT": return getDefaultArgSource(verb);
    default: throw new Error(`Unexpected ArgSource argument: ${argSource.args[0].name.text}`);
  }

  function getDefaultArgSource(verb: APITypes): ArgSources.BODY | ArgSources.QUERY {
    switch (verb) {
      case APITypes.GET: return ArgSources.QUERY;
      case APITypes.POST: return ArgSources.BODY;
    }
  }
}

function getParamName(parameter: ParameterInfo): string {
  const argName = getOperonDecorator(parameter, 'ArgName');
  if (!argName) return parameter.name;

  const nameParam = argName.args[0];
  if (nameParam && ts.isStringLiteral(nameParam)) return nameParam.text;

  throw new Error(`Unexpected ArgName argument type: ${ts.SyntaxKind[nameParam.kind]}`);
}

// ts-json-schema-generator does not support BigInt, so OpenApiGenerator needs a custom type, formatter and parser for it
class BigIntType extends PrimitiveType {
  getId(): string { return "integer"; }
}


class BigIntKeywordParser implements SubNodeParser {
  supportsNode(node: ts.Node): boolean {
    return node.kind === ts.SyntaxKind.BigIntKeyword;
  }
  createType(node: ts.Node, context: Context, reference?: ReferenceType | undefined): BaseType {
    // return new AnnotatedType(new NumberType(), { format: "bigint" }, false);
    return new BigIntType();
  }
}

class BigIntTypeFormatter implements SubTypeFormatter {
  public supportsType(type: BigIntType): boolean {
    return type instanceof BigIntType;
  }
  public getDefinition(type: BigIntType): Definition {
    // Note, JSON Schema integer type is not constrained to a specific size, so it is a valid type for BigInt
    return { type: "integer", description: "bigint" };
  }
  public getChildren(type: BigIntType): BaseType[] {
    return [];
  }
}

export class OpenApiReferenceTypeFormatter implements SubTypeFormatter {
  public constructor(
    protected childTypeFormatter: TypeFormatter,
    protected encodeRefs: boolean
  ) { }

  public supportsType(type: ReferenceType): boolean {
    return type instanceof ReferenceType;
  }
  public getDefinition(type: ReferenceType): Definition {
    const ref = type.getName();
    return { $ref: `#/components/schemas/${this.encodeRefs ? encodeURIComponent(ref) : ref}` };
  }
  public getChildren(type: ReferenceType): BaseType[] {
    const referredType = type.getType();
    if (referredType instanceof DefinitionType) {
      // We probably already have the definitions for the children created so we could return `[]`.
      // There are cases where we may not have (in particular intersections of unions with recursion).
      // To make sure we create the necessary definitions, we return the children of the referred type here.
      // Because we cache definitions, this should not incur any performance impact.
      return this.childTypeFormatter.getChildren(referredType);
    }

    // this means that the referred interface is protected
    // so we have to expose it in the schema definitions
    return this.childTypeFormatter.getChildren(new DefinitionType(type.getName(), type.getType()));
  }
}

export class OpenApiDefinitionTypeFormatter implements SubTypeFormatter {
  public constructor(
    protected childTypeFormatter: TypeFormatter,
    protected encodeRefs: boolean
  ) { }

  public supportsType(type: DefinitionType): boolean {
    return type instanceof DefinitionType;
  }
  public getDefinition(type: DefinitionType): Definition {
    const ref = type.getName();
    return { $ref: `#/components/schemas/${this.encodeRefs ? encodeURIComponent(ref) : ref}` };
  }
  public getChildren(type: DefinitionType): BaseType[] {
    return uniqueArray([type, ...this.childTypeFormatter.getChildren(type.getType())]);
  }
}

class OpenApiGenerator {
  readonly checker: ts.TypeChecker;
  readonly schemaGenerator: SchemaGenerator;
  readonly schemaMap: Map<string, OpenApi3.SchemaObject> = new Map();

  constructor(readonly program: ts.Program, readonly log: WinstonLogger) {
    this.checker = program.getTypeChecker();
    const config: Config = {
      discriminatorType: 'open-api',
      encodeRefs: false
    };
    const parser = createParser(program, config, aug => aug.addNodeParser(new BigIntKeywordParser()));
    const formatter = createFormatter(config, (fmt, circRefFmt) => {
      // fmt.addTypeFormatter(new OpenApiReferenceTypeFormatter(circRefFmt, config.encodeRefs!));
      // fmt.addTypeFormatter(new OpenApiDefinitionTypeFormatter(circRefFmt, config.encodeRefs!));
      return fmt.addTypeFormatter(new BigIntTypeFormatter());
    });
    this.schemaGenerator = new SchemaGenerator(program, parser, formatter, {});
  }

  generate(classes: readonly ClassInfo[]): OpenApi3.Document {
    const handlers = classes
      .flatMap(c => c.methods)
      .map(method => {
        const http = getHttpInfo(method);
        return http ? [method, http] as [MethodInfo, HttpEndpointInfo] : undefined;
      })
      .filter(isValid);

    const paths = handlers
      .map(h => this.generatePath(h));

    const openApi: OpenApi3.Document = {
      openapi: "3.0.3", // https://spec.openapis.org/oas/v3.0.3
      info: {
        // TODO: Where to get this info from? package.json?
        title: "Operon API",
        version: "1.0.0",
      },
      paths: Object.fromEntries(paths),
      components: {
        schemas: Object.fromEntries(this.schemaMap)
      }
    }

    // ts-json-schema-generator emits all definitions in the definitions field, but OpenApi expects them in the components.schemas field
    // I'm going to open an issue w/ ts-json-schema-generator to make this configurable.
    const text = JSON.stringify(openApi, null, 4);
    const newText = text.replaceAll("#/definitions/", "#/components/schemas/");
    return JSON.parse(newText) as OpenApi3.Document;
  }

  generatePath([method, { verb, path }]: [MethodInfo, HttpEndpointInfo]): [string, OpenApi3.PathItemObject] {
    // The first parameter of a handle method must be an OperonContext, which is not exposed via the API
    const sourcedParams = method.parameters
      .slice(1)
      .map(p => [p, getParamSource(p, verb)] as [ParameterInfo, ArgSources]);

    const parameters = this.generateParameters(sourcedParams);
    const requestBody = this.generateRequestBody(sourcedParams);

    const operation: OpenApi3.OperationObject = {
      operationId: method.name,
      responses: Object.fromEntries([this.generateResponse(method)]),
      parameters,
      requestBody,
    }

    switch (verb) {
      case APITypes.GET: return [path, { get: operation }];
      case APITypes.POST: return [path, { post: operation }];
    }
  }

  generateResponse(method: MethodInfo): [string, OpenApi3.ResponseObject] {
    const signature = this.checker.getSignatureFromDeclaration(method.node);
    const returnType = signature?.getReturnType();
    if (!returnType) throw new Error(`Method ${method.name} has no return type`);

    // Operon handlers must return a promise. Since this is enforced by the type system
    // extract the first type argument w/o checking if it's a promise
    const typeArg = (returnType as ts.TypeReference).typeArguments![0];

    // if the type argument is void, return a 204 status code with no content
    if (typeArg.flags & ts.TypeFlags.Void) return ["204", { description: "No Content" }];

    const decl = signature ? this.checker.signatureToSignatureDeclaration(signature, method.node.kind, undefined, undefined) : undefined;
    const schema = this.generateSchema(decl?.type);

    return ["200", {
      description: "Ok",
      content: {
        "application/json": { schema }
      }
    }];
  }

  generateParameters(sourcedParams: [ParameterInfo, ArgSources][]): OpenApi3.ParameterObject[] {
    return sourcedParams
      // QUERY and URL parameters are specified in the Operation.parameters field
      .filter(([_, source]) => source === ArgSources.QUERY || source === ArgSources.URL)
      .map(([parameter, argSource]) => this.generateParameter(parameter, argSource));
  }

  generateParameter(parameter: ParameterInfo, argSource: ArgSources): OpenApi3.ParameterObject {
    if (argSource === ArgSources.BODY) throw new Error(`BODY parameters must be specified in the Operation.requestBody field: ${parameter.name}`);
    if (argSource === ArgSources.URL && !parameter.required) throw new Error(`URL parameters must be required: ${parameter.name}`);

    const schema = this.generateSchema(parameter.node);

    return {
      name: getParamName(parameter),
      in: getLocation(argSource),
      required: parameter.required,
      schema
    };

    function getLocation(argSource: ArgSources): "query" | "path" {
      switch (argSource) {
        case ArgSources.QUERY: return 'query';
        case ArgSources.URL: return 'path';
        default: throw new Error(`Unsupported Parameter ArgSource: ${argSource}`);
      }
    }
  }

  generateRequestBody(sourcedParams: [ParameterInfo, ArgSources][]): OpenApi3.RequestBodyObject | undefined {
    // BODY parameters are specified in the Operation.requestBody field
    const parameters = sourcedParams
      .filter(([_, source]) => source === ArgSources.BODY)
      .map(([parameter, _]) => [getParamName(parameter), parameter] as [name: string, ParameterInfo]);

    if (parameters.length === 0) return undefined;

    const properties = parameters.map(([name, parameter]) => [name, this.generateSchema(parameter.node)] as [string, OpenApi3.SchemaObject]);
    const schema: OpenApi3.SchemaObject = {
      type: 'object',
      properties: Object.fromEntries(properties),
      required: parameters.filter(([_, parameter]) => parameter.required).map(([name, _]) => name),
    }

    return {
      required: true,
      content: {
        "application/json": { schema }
      }
    }
  }

  generateSchema(node?: ts.Node): OpenApi3.SchemaObject {
    if (!node) return { description: "Undefined Node" };

    const text = printNode(node);
    const schema = this.schemaGenerator.createSchemaFromNodes([node]);

    if (!schema.$ref) return { description: "No $ref" };

    const slashIndex = schema.$ref.lastIndexOf('/');
    if (slashIndex === -1) return { description: `Invalid $ref ${schema.$ref}` };
    const name = schema.$ref.substring(slashIndex + 1);

    const defs = new Map<string, Schema | boolean>(Object.entries(schema.definitions ?? {}));
    if (defs.size === 0) return { description: "No definitions" };
    const def = defs.get(name);

    if (!def) return { description: `No definition ${name}` };
    if (typeof def === 'boolean') return { description: `Definition ${name} is a boolean` };

    if (defs.size > 1) {
      defs.delete(name);
      for (const [$name, $def] of defs) {
        if (typeof $def === 'boolean') continue;
        this.schemaMap.set($name, $def as OpenApi3.SchemaObject);
      }
    }

    return def as OpenApi3.SchemaObject;
  }
}

// function mapReferences(schema: Schema): Schema {
//   if (schema.$ref) {
//     const slashIndex = schema.$ref.lastIndexOf('/');
//     if (slashIndex === -1) throw new Error(`Invalid $ref ${schema.$ref}`);
//     const name = schema.$ref.substring(slashIndex + 1);
//     return {
//       $ref: `#/components/schemas/${name}`
//     };
//   }
//   if (schema.type === 'object') {
//     const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, prop]) => [name, mapReferences(prop as Schema)]));
//     return { ...schema, properties };
//   }
//   if (schema.type === 'array') {
//     const items = mapReferences(schema.items as Schema);
//     return { ...schema, items };
//   }
//   if (schema.anyOf) {
//     const anyOf = schema.anyOf.map(s => mapReferences(s as Schema));
//     return { ...schema, anyOf };
//   }
//   return schema;
// }



const printer = ts.createPrinter();
function printNode(node: ts.Node, hint?: ts.EmitHint, sourceFile?: ts.SourceFile): string {
  sourceFile ??= ts.createSourceFile("temp.ts", "", ts.ScriptTarget.Latest);
  return printer.printNode(hint ?? ts.EmitHint.Unspecified, node, sourceFile);
}

export function generateOpenApi(program: ts.Program, logger?: WinstonLogger): OpenApi3.Document {
  logger ??= createGlobalLogger();

  const classes = TypeParser.parse(program, logger);
  const generator = new OpenApiGenerator(program, logger);
  return generator.generate(classes);
}
