/**
 * ER diagrams for SQL plugins:
 *
 *   import { ErDiagram, type ErModel } from "@oneclient/editor-kit/erd";
 *   import "@oneclient/editor-kit/erd.css";
 *
 * The plugin's backend extracts an ErModel from its catalog; the view draws it.
 */
export { ErDiagram, type ErDiagramProps } from "./ErDiagram.js";
export { DiagramPage, type DiagramPageProps } from "./DiagramPage.js";
export {
  type Box,
  type ColumnMode,
  type ErColumn,
  type ErModel,
  type ErRelation,
  type ErTable,
  type Layout,
  bounds,
  edgeGeometry,
  isOneToOne,
  layoutModel,
  measure,
  toDbml,
  toMermaid,
  toSvg,
  visibleColumns,
} from "./model.js";
