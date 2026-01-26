type Minimize24RegularProps = React.SVGProps<SVGSVGElement> & {
  size: string;
};

const Minimize24Regular = ({ size, className, ...props }: Minimize24RegularProps) => (
  <svg
    width={size}
    height={size}
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    className={className}
    fill="currentColor"
    {...props}
  >
    <g fill="none">
      <path
        d="M3.755 12.5h16.492a.75.75 0 1 0 0-1.5H3.755a.75.75 0 0 0 0 1.5z"
        fill="currentColor"
      />
    </g>
  </svg>
);

export default Minimize24Regular;
