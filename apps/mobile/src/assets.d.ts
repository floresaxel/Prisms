// Static images: Metro turns an import of a .png (and its @2x/@3x siblings)
// into an asset reference that <Image source> takes as is.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}
