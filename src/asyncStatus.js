/**
 * The three states every asynchronous surface can be in.
 *
 * Lives in its own module because a file that exports both components and
 * constants breaks React Fast Refresh.
 */
export const STATUS = {
  LOADING: 'loading',
  ERROR: 'error',
  READY: 'ready'
};

export default STATUS;
