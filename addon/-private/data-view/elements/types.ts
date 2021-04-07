export interface IVirtualComponent {
    destroy: () => void;
    index?: number;
    recycle: (item: unknown) => void;
}